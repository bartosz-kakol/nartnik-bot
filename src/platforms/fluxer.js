// Fluxer adapter: turns @fluxerjs/core events into bridge messages and sends through webhooks.

import { Client, Events, Webhook } from "@fluxerjs/core";
import { createLogger } from "../log.js";

const log = createLogger("fluxer");
const RELAYED_TYPES = new Set([0, 19]); // MessageType.Default, MessageType.Reply
const ATTACHMENT_SPOILER = 8; // MessageAttachmentFlags.IS_SPOILER

export class FluxerAdapter {
	name = "fluxer";

	/**
	 * @param {object} deps
	 * @param {ReturnType<import('../config.js').loadConfig>} deps.config
	 * @param {ReturnType<import('../db.js').openDatabase>} deps.db
	 * @param {import('../core/mappings.js').Mappings} deps.mappings  live mappings
	 */
	constructor({ config, db, mappings }) {
		this.config = config;
		this.db = db;
		this.guildId = config.fluxer.guildId;
		this.mappings = mappings;
		this.ownWebhookIds = db.webhookIds("fluxer");
		this.webhooks = new Map(); // channelId -> Webhook
		this.client = null;
	}

	/**
	 * @param {object} handlers
	 * @param {(channelId:string, prepare:()=>Promise<object|null>)=>void} handlers.onMessage
	 * @param {(channelId:string, messageId:string, prepare:()=>Promise<object|null>)=>void} handlers.onEdit
	 * @param {(channelId:string, messageId:string)=>void} handlers.onDelete
	 * @param {(msg:object)=>boolean} handlers.onCommand  return true when the message was a command
	 * @param {(reaction:{channelId:string,messageId:string,userId:string,emoji:string})=>void} handlers.onReaction
	 */
	async start(handlers) {
		this.client = await this.createClient();
		const c = this.client;

		c.on(Events.MessageCreate, (msg) => {
			if (msg.guildId !== this.guildId || msg.author?.id === c.user?.id) return;
			if (
				msg.content?.startsWith(this.config.commandPrefix) &&
				!msg.webhookId &&
				handlers.onCommand(msg)
			)
				return;
			
			if (!this.isRelayable(msg)) return;

			handlers.onMessage(msg.channelId, () => this.normalize(msg));
		});

		c.on(Events.MessageUpdate, (_old, msg) => {
			if (!this.isMapped(msg.channelId)) return;
			if (
				!msg.partial &&
				msg.webhookId &&
				this.ownWebhookIds.has(msg.webhookId)
			) {
				return;
			}

			handlers.onEdit(msg.channelId, msg.id, async () => {
				const full = msg.partial
					? await this.fetchMessage(msg.channelId, msg.id)
					: msg;
				
				if (!full || !full.editedAt || !this.isRelayable(full)) {
					return null;
				}
				
				return this.normalize(full);
			});
		});

		c.on(Events.MessageDelete, (msg) => {
			if (!this.isMapped(msg.channelId)) {
				return;
			}

			handlers.onDelete(msg.channelId, msg.id);
		});

		c.on(Events.MessageDeleteBulk, (payload) => {
			if (!this.isMapped(payload.channelId)) {
				return;
			}

			for (const id of payload.ids) {
				handlers.onDelete(payload.channelId, id);
			}
		});

		c.on(Events.MessageReactionAdd, (payload) => {
			handlers.onReaction({
				channelId: payload.channelId,
				messageId: payload.messageId,
				userId: payload.userId,
				emoji: payload.emoji?.name ?? "",
			});
		});

		c.on(Events.Error, (err) => log.error("client error:", err));

		const ready = new Promise((resolve) => c.once(Events.Ready, resolve));

		await c.login(this.config.secrets.fluxerToken);
		await ready;

		log.info(
			`logged in as ${c.user?.username ?? "bot"} (API ${c.instance.endpoints.api_public})`,
		);

		this.guild = c.guilds.get(this.guildId) ?? (await c.guilds.resolve(this.guildId).catch(() => null));
		if (!this.guild) {
			throw new Error(`Fluxer bot is not a member of guild ${this.guildId}`);
		}
	}

	async createClient() {
		try {
			return await Client.fromDiscovery(this.config.fluxer.instance);
		} catch (err) {
			log.warn(
				`instance discovery at ${this.config.fluxer.instance} failed (${err.message}); using SDK defaults`,
			);

			return new Client();
		}
	}

	async stop() {
		await this.client?.destroy?.();
	}

	/** Whether a Fluxer channel is bridged. Reads the live mappings, so map/unmap apply at once. */
	isMapped(channelId) {
		return this.mappings.channel.fluxer.has(channelId);
	}

	isRelayable(msg) {
		if (msg.guildId !== this.guildId || !this.isMapped(msg.channelId)) return false;
		if (msg.author?.id === this.client.user?.id) return false;
		if (msg.webhookId && this.ownWebhookIds.has(msg.webhookId)) return false;
		if (!RELAYED_TYPES.has(msg.type)) return false;
		
		return true;
	}

	async fetchMessage(channelId, messageId) {
		try {
			const channel = await this.client.channels.resolve(channelId);
			return await channel.messages.fetch(messageId);
		} catch {
			return null;
		}
	}

	async member(userId) {
		return this.guild.members.resolve(userId).catch(() => null);
	}

	/** Convert a Fluxer Message into a platform-neutral bridge message. */
	async normalize(msg) {
		const member = msg.webhookId
			? null
			: (msg.member ?? (await this.member(msg.author.id)));
		
		const bridge = this.baseMessage(msg, member);

		if (
			msg.messageReference?.messageId &&
			msg.messageReference.type !== 1 /* forward */
		) {
			const ref =
				msg.referencedMessage ??
				(await this.fetchMessage(
					msg.channelId,
					msg.messageReference.messageId,
				));
			if (ref) {
				const refMember = ref.webhookId
					? null
					: this.guild.members.get(ref.author.id);
				bridge.reference = {
					...this.baseMessage(ref, refMember),
					pingAuthor: (msg.mentions ?? []).some((u) => u.id === ref.author.id),
				};
			} else {
				bridge.reference = {
					id: msg.messageReference.messageId,
					missing: true,
				};
			}
		}
		return bridge;
	}

	baseMessage(msg, member) {
		const author = msg.author;
		const userName = (u) =>
			u &&
			(this.guild.members.get(u.id)?.displayName ?? u.globalName ?? u.username);
		
		return {
			platform: "fluxer",
			id: msg.id,
			channelId: msg.channelId,
			author: {
				id: author.id,
				name: member?.displayName ?? author.globalName ?? author.username,
				avatarUrl: (member ?? author).displayAvatarURL({
					extension: "png",
					size: 256,
				}),
			},
			content: msg.content ?? "",
			attachments: [...msg.attachments.values()]
				.filter((a) => a.url || a.proxyUrl)
				.map((a) => ({
					url: a.url ?? a.proxyUrl,
					name: a.filename,
					size: a.size,
					contentType: a.contentType,
					spoiler: (a.flags & ATTACHMENT_SPOILER) !== 0,
				})),
			embeds: msg.embeds ?? [],
			names: {
				users: {
					get: (id) =>
						userName(
							(msg.mentions ?? []).find((u) => u.id === id) ??
								this.client.users?.get?.(id),
						),
				},
				roles: { get: (id) => this.guild.roles.get(id)?.name },
				channels: { get: (id) => this.client.channels.get(id)?.name },
			},
			reference: null,
		};
	}

	// ---------------------------------------------------------------- sending

	uploadLimit() {
		return this.config.limits.fluxerUploadBytes;
	}

	jumpUrl(channelId, messageId) {
		const base = this.client.instance.endpoints.webapp ?? "https://web.fluxer.app";

		return `${base}/channels/${this.guildId}/${channelId}/${messageId}`;
	}

	emojiImageUrl({ id, animated }) {
		const media = this.client.instance.endpoints.media;

		return animated
			? `${media}/emojis/${id}.gif?animated=true`
			: `${media}/emojis/${id}.png`;
	}

	async ensureWebhook(channelId) {
		if (this.webhooks.has(channelId)) {
			return this.webhooks.get(channelId);
		}

		let stored = this.db.getWebhook("fluxer", channelId);

		if (!stored) {
			const channel = await this.client.channels.resolve(channelId);

			if (!channel?.createWebhook) {
				throw new Error(`Fluxer channel ${channelId} cannot have webhooks`);
			}

			const created = await channel.createWebhook({
				name: this.config.webhookName,
			});

			if (!created.token) {
				throw new Error(
					`Fluxer did not return a token for the webhook in ${channelId}`,
				);
			}

			stored = { id: created.id, token: created.token };
			this.db.putWebhook("fluxer", channelId, stored);

			log.info(`created webhook ${stored.id} in channel ${channelId}`);
		}

		this.ownWebhookIds.add(stored.id);
		const webhook = Webhook.fromToken(this.client, stored.id, stored.token, {
			channelId,
			guildId: this.guildId,
		});
		this.webhooks.set(channelId, webhook);

		return webhook;
	}

	/** Run a webhook call, recreating the webhook once if it was deleted on Fluxer. */
	async withWebhook(channelId, fn) {
		const webhook = await this.ensureWebhook(channelId);
		
		try {
			return await fn(webhook);
		} catch (err) {
			if (!isUnknownWebhook(err)) {
				throw err;
			}

			log.warn(`webhook for channel ${channelId} is gone, creating a new one`);
			this.webhooks.delete(channelId);
			this.db.deleteWebhook("fluxer", channelId);

			return fn(await this.ensureWebhook(channelId));
		}
	}

	/**
	 * @param {string} channelId
	 * @param {import('../core/relay.js').OutgoingMessage} out
	 * @returns {Promise<string>} the new message ID
	 */
	async send(channelId, out) {
		const sent = await this.withWebhook(channelId, (wh) =>
			wh.send(
				{
					content: out.content || undefined,
					username: out.username,
					avatarUrl: out.avatarUrl ?? undefined,
					embeds: out.embeds.length ? out.embeds : undefined,
					files: out.files.length
						? out.files.map((f) => ({ name: f.name, data: f.data }))
						: undefined,
					attachments: out.files.length
						? out.files.map((f, i) => ({
								id: i,
								filename: f.name,
								...(f.spoiler && { flags: ATTACHMENT_SPOILER }),
							}))
						: undefined,
					allowedMentions: {
						parse: [],
						users: out.mentionUserIds,
						repliedUser: Boolean(out.reply?.ping),
					},
					...(out.reply && {
						replyTo: {
							channelId,
							messageId: out.reply.messageId,
							guildId: this.guildId,
						},
					}),
				},
				true,
			),
		);

		if (!sent?.id) {
			throw new Error("Fluxer webhook did not return the created message");
		}

		return sent.id;
	}

	async edit(channelId, messageId, out) {
		await this.withWebhook(channelId, (wh) =>
			wh.editMessage(messageId, {
				content: out.content,
				embeds: out.embeds,
				allowedMentions: { parse: [], users: out.mentionUserIds },
			}),
		).catch((err) => {
			if (!isUnknownMessage(err)) throw err;
		});
	}

	async delete(channelId, messageId) {
		await this.withWebhook(channelId, (wh) =>
			wh.deleteMessage(messageId),
		).catch((err) => {
			if (!isUnknownMessage(err)) throw err;
		});
	}

	// ---------------------------------------------------------------- bot messages (commands)

	async post(channelId, content, { replyTo } = {}) {
		const channel = await this.client.channels.resolve(channelId);
		const msg = await channel.send({
			content,
			allowedMentions: { parse: [] },
			...(replyTo && {
				replyTo: { channelId, messageId: replyTo, guildId: this.guildId },
				ping: false,
			}),
		});

		return msg.id;
	}

	async react(channelId, messageId, emoji) {
		const msg = await this.fetchMessage(channelId, messageId);

		await msg?.react(emoji);
	}

	/** Whether a user is a member of the bridged Fluxer server. */
	async isMember(userId) {
		const member = await this.guild.members.fetch(userId).catch(() => null);
		return Boolean(member);
	}

	/** Name of a role of the bridged Fluxer server, or null. */
	async lookupRole(roleId) {
		const role =
			this.guild.roles.get(roleId) ??
			(await this.guild.fetchRole(roleId).catch(() => null));
		return role?.name ?? null;
	}

	async memberRoleIds(userId) {
		const member = await this.guild.members
			.fetch(userId, { force: true })
			.catch(() => null);
		
		return member ? [...member.roles.roleIds] : [];
	}
}

function isUnknownWebhook(err) {
	return err?.statusCode === 404 && !/MESSAGE/i.test(String(err.code ?? ""));
}

function isUnknownMessage(err) {
	return err?.statusCode === 404 && /MESSAGE/i.test(String(err.code ?? ""));
}
