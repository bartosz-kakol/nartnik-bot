// Platform-neutral relay: per-target-channel queues, message building, and the message ID map.

import { createLogger } from "../log.js";
import { Mappings } from "./mappings.js";
import {
	clip,
	planAttachments,
	replyQuoteLine,
	snippet,
	soloUnmappedEmoji,
	toWireEmbed,
	transformContent,
	webhookUsername,
} from "./transform.js";

const log = createLogger("relay");
const OTHER = { discord: "fluxer", fluxer: "discord" };
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * @typedef {object} OutgoingMessage
 * @property {string} username
 * @property {string|null} avatarUrl
 * @property {string} content
 * @property {object[]} embeds         wire-format embeds
 * @property {{name:string,data:Buffer,spoiler:boolean}[]} files
 * @property {string[]} mentionUserIds target-platform users allowed to be pinged
 * @property {{messageId:string,ping:boolean}|null} reply  real reply (Fluxer only)
 */

/** Runs jobs one at a time per key, in the order they were added. */
export class KeyedQueue {
	constructor() {
		this.tails = new Map();
		this.sizes = new Map();
	}

	/** Add a job; the returned promise settles with the job's own result. */
	push(key, job) {
		const tail = this.tails.get(key) ?? Promise.resolve();
		const run = tail.then(job);
		const settled = run.catch(() => {});

		this.tails.set(key, settled);
		this.sizes.set(key, (this.sizes.get(key) ?? 0) + 1);

		settled.then(() => {
			const left = this.sizes.get(key) - 1;

			if (left === 0) {
				this.sizes.delete(key);
				this.tails.delete(key);
			} else {
				this.sizes.set(key, left);
			}
		});

		return run;
	}

	size(key) {
		return this.sizes.get(key) ?? 0;
	}

	/** Resolves once every job queued so far has finished. */
	async drain() {
		await Promise.all([...this.tails.values()]);
	}
}

export class Relay {
	/**
	 * @param {object} deps
	 * @param {object} deps.config
	 * @param {object} deps.db
	 * @param {{discord:object, fluxer:object}} deps.adapters
	 * @param {Mappings} [deps.mappings]  live mappings (default: built from config's lists, for tests)
	 * @param {typeof fetch} [deps.fetch]
	 */
	constructor({
		config,
		db,
		adapters,
		mappings = new Mappings({ lists: config }),
		fetch: fetchImpl = globalThis.fetch,
	}) {
		this.config = config;
		this.db = db;
		this.adapters = adapters;
		this.fetch = fetchImpl;
		// Live maps: map/unmap commands change them in place.
		this.mappings = mappings;
		this.channels = mappings.channel;
		this.users = mappings.user;
		this.emoji = mappings.emoji;
		this.roles = mappings.role;
		this.queue = new KeyedQueue();
		// Jobs queued before both platforms are logged in wait here, keeping their order.
		this.ready = new Promise((resolve) => {
			this.markReady = resolve;
		});
	}

	/** Counterpart channel of a mapped channel, or undefined. */
	targetChannel(from, channelId) {
		return this.channels[from].get(channelId);
	}

	/** Queue work on the channel that will receive the output, so output stays in order. */
	enqueue(to, channelId, job) {
		return this.queue.push(`${to}:${channelId}`, async () => {
			await this.ready;
			return job();
		});
	}

	// ---------------------------------------------------------------- event entry points

	/** A new message on `from`. `prepare` resolves to a bridge message, or null to skip. */
	onMessage(from, channelId, prepare) {
		const to = OTHER[from];
		const target = this.targetChannel(from, channelId);

		if (!target) {
			return Promise.resolve();
		}

		return this.enqueue(to, target, async () => {
			const msg = await prepare();

			if (msg) {
				await this.relayNew(msg);
			}
		}).catch((err) =>
			log.error(
				`failed to relay ${from} message in ${channelId}:`,
				describe(err),
			),
		);
	}

	onEdit(from, channelId, messageId, prepare) {
		const to = OTHER[from];
		const target = this.targetChannel(from, channelId);

		if (!target) {
			return Promise.resolve();
		}

		return this.enqueue(to, target, async () => {
			const pair = this.db.findPair(from, messageId);
			if (!pair || pair.origin !== from) {
				return; // not bridged, or an edit of own mirror
			}

			const msg = await prepare();
			if (msg) {
				await this.relayEdit(msg, pair[to]);
			}
		}).catch((err) =>
			log.error(`failed to relay ${from} edit of ${messageId}:`, describe(err)),
		);
	}

	onDelete(from, channelId, messageId) {
		const to = OTHER[from];
		const target = this.targetChannel(from, channelId);

		if (!target) {
			return Promise.resolve();
		}

		return this.enqueue(to, target, async () => {
			const pair = this.db.findPair(from, messageId);
			if (!pair) {
				return;
			}

			this.db.deletePair(from, messageId);

			// Deleting a mirror only forgets the pair; deleting an original removes its mirror too.
			if (pair.origin !== from) {
				return;
			}

			await this.adapters[to].delete(pair[to].channelId, pair[to].messageId);

			log.debug(`deleted ${to} mirror ${pair[to].messageId}`);
		}).catch((err) =>
			log.error(
				`failed to relay ${from} delete of ${messageId}:`,
				describe(err),
			),
		);
	}

	// ---------------------------------------------------------------- relaying

	/** Post a bridge message on the other platform and record the pair. Returns the mirror ID or null. */
	async relayNew(msg) {
		const from = msg.platform;
		const to = OTHER[from];
		const targetChannelId = this.targetChannel(from, msg.channelId);
		const out = await this.build(msg, to, { download: true });

		if (!out) {
			log.debug(`skipped empty ${from} message ${msg.id}`);
			return null;
		}

		const mirrorId = await this.adapters[to].send(targetChannelId, out);
		const source = { channelId: msg.channelId, messageId: msg.id };
		const mirror = { channelId: targetChannelId, messageId: mirrorId };

		if (from === "discord") {
			this.db.putPair("discord", source, mirror);
		} else {
			this.db.putPair("fluxer", mirror, source);
		}

		log.debug(`relayed ${from} ${msg.id} -> ${to} ${mirrorId}`);

		return mirrorId;
	}

	async relayEdit(msg, mirror) {
		const to = OTHER[msg.platform];
		const out = await this.build(msg, to, { download: false });

		if (!out) {
			return;
		}

		await this.adapters[to].edit(mirror.channelId, mirror.messageId, out);

		log.debug(`edited ${to} mirror ${mirror.messageId}`);
	}

	/**
	 * Turn a bridge message into what the target webhook should post.
	 * With `download: false` (edits) no files are fetched, but oversized attachments still produce the same
	 * link lines so the edited text matches the original post.
	 * @returns {Promise<OutgoingMessage|null>}
	 */
	async build(msg, to, { download }) {
		const from = msg.platform;
		const target = this.adapters[to];
		const source = this.adapters[from];
		const files = [];
		let content;
		let mentionUserIds = [];

		// A message that is only an unmapped custom emoji is sent as an image of that emoji.
		const solo =
			msg.attachments.length === 0 && msg.embeds.length === 0
				? soloUnmappedEmoji(msg.content, from, this.emoji)
				: null;
		
		if (solo) {
			if (!download) {
				return null;
			}

			const ext = solo.animated ? "gif" : "png";
			const data = await this.download(source.emojiImageUrl(solo)).catch(
				(err) => {
					log.warn(
						`could not fetch emoji ${solo.name} (${solo.id}): ${err.message}`,
					);
					return null;
				},
			);

			if (data) {
				files.push({ name: `${solo.name}.${ext}`, data, spoiler: false });
				content = "";
			}
		}

		if (content === undefined) {
			const ctx = {
				from,
				users: this.users,
				channels: this.channels,
				emoji: this.emoji,
				roles: this.roles,
				names: msg.names,
			};

			({ content, mentionedUserIds: mentionUserIds } = transformContent(
				msg.content,
				ctx,
			));
		}

		// Attachments: upload what fits, link the rest.
		const plan = planAttachments(msg.attachments, target.uploadLimit());
		const links = [...plan.link];

		if (download) {
			for (const att of plan.upload) {
				try {
					files.push({
						name: att.name,
						data: await this.download(att.url),
						spoiler: att.spoiler,
					});
				} catch (err) {
					log.warn(`could not download attachment ${att.name}: ${err.message}`);
					links.push(att);
				}
			}
		}
		
		if (links.length) {
			const lines = links.map((a) =>
				a.spoiler ? `📎 ${a.name}: ||${a.url}||` : `📎 ${a.name}: ${a.url}`,
			);

			content = [content, ...lines].filter(Boolean).join("\n");
		}

		// Replies: a real reply on Fluxer when the target message is known, otherwise a quote line.
		let reply = null;

		if (msg.reference) {
			const counterpart = this.db.counterpart(from, msg.reference.id);
			if (to === "fluxer" && counterpart) {
				reply = {
					messageId: counterpart.messageId,
					ping: Boolean(msg.reference.pingAuthor),
				};
			} else {
				content = `${this.quoteLine(msg.reference, from, to, counterpart)}\n${content}`;
			}
		}

		const embeds = msg.embeds.map(toWireEmbed).filter(Boolean).slice(0, 10);
		content = clip(content.trimEnd());

		if (!content && files.length === 0 && embeds.length === 0) {
			return null;
		}

		return {
			username: webhookUsername(msg.author.name, to),
			avatarUrl: msg.author.avatarUrl ?? null,
			content,
			embeds,
			files,
			mentionUserIds: this.config.pingLinkedUsers ? mentionUserIds : [],
			reply,
		};
	}

	quoteLine(ref, from, to, counterpart) {
		if (ref.missing) {
			return replyQuoteLine({
				authorName: "unknown",
				text: "*original message not found*",
			});
		}
		
		const ctx = {
			from,
			users: this.users,
			channels: this.channels,
			emoji: this.emoji,
			roles: this.roles,
			names: ref.names,
			linkUsers: false, // never ping from a quote
		};

		let text = snippet(transformContent(ref.content, ctx).content);

		if (!text && ref.attachments?.length) 	text = "*attachment*";
		if (!text && ref.embeds?.length) 		text = "*embed*";
		
		const jumpUrl = counterpart
			? this.adapters[to].jumpUrl(counterpart.channelId, counterpart.messageId)
			: null;
		
		return replyQuoteLine({ authorName: ref.author.name, text, jumpUrl });
	}

	async download(url) {
		const res = await this.fetch(url, {
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});

		if (!res.ok) {
			throw new Error(`HTTP ${res.status} for ${url}`);
		}

		return Buffer.from(await res.arrayBuffer());
	}

	/** Create missing webhooks for every mapped channel up front, so problems show at startup. */
	async prepareWebhooks() {
		for (const [discordId, fluxerId] of this.channels.discord) {
			const pair = { discord: discordId, fluxer: fluxerId };
			for (const platform of ["discord", "fluxer"]) {
				try {
					await this.adapters[platform].ensureWebhook(pair[platform]);
				} catch (err) {
					log.error(
						`cannot set up a ${platform} webhook for channel ${pair[platform]}:`,
						describe(err),
					);
				}
			}
		}
	}
}

export function describe(err) {
	if (!err) return String(err);

	const status = err.status ?? err.statusCode;
	const code = err.code !== undefined ? ` code=${err.code}` : "";
	
	return `${err.message ?? err}${status ? ` (HTTP ${status}${code})` : code}`;
}
