// Discord adapter: turns discord.js events into bridge messages and sends through webhooks.

import {
	Client,
	Events,
	GatewayIntentBits,
	GuildPremiumTier,
	MessageType,
	Partials,
	RESTJSONErrorCodes,
	WebhookClient,
} from "discord.js";
import { createLogger } from "../log.js";

const log = createLogger("discord");
const MiB = 1024 * 1024;
const RELAYED_TYPES = new Set([MessageType.Default, MessageType.Reply]);

export class DiscordAdapter {
	name = "discord";

	/**
	 * @param {object} deps
	 * @param {ReturnType<import('../config.js').loadConfig>} deps.config
	 * @param {ReturnType<import('../db.js').openDatabase>} deps.db
	 * @param {import('../core/mappings.js').Mappings} deps.mappings  live mappings
	 */
	constructor({ config, db, mappings }) {
		this.config = config;
		this.db = db;
		this.guildId = config.discord.guildId;
		this.mappings = mappings;
		this.ownWebhookIds = db.webhookIds("discord");
		this.webhooks = new Map(); // channelId -> WebhookClient
		this.handlers = null;
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.GuildMembers,
				GatewayIntentBits.MessageContent,
			],
			partials: [Partials.Message, Partials.Channel],
			allowedMentions: { parse: [] },
		});
	}

	/**
	 * @param {object} handlers
	 * @param {(channelId:string, prepare:()=>Promise<object|null>)=>void} handlers.onMessage
	 * @param {(channelId:string, messageId:string, prepare:()=>Promise<object|null>)=>void} handlers.onEdit
	 * @param {(channelId:string, messageId:string)=>void} handlers.onDelete
	 */
	async start(handlers) {
		this.handlers = handlers;
		const c = this.client;

		c.on(Events.MessageCreate, (msg) => {
			if (!this.isRelayable(msg)) {
				return;
			}
			
			handlers.onMessage(msg.channelId, () => this.normalize(msg));
		});

		c.on(Events.MessageUpdate, (_old, msg) => {
			if (
				msg.guildId !== this.guildId ||
				!this.isMapped(msg.channelId)
			) {
				return;
			}

			if (msg.webhookId && this.ownWebhookIds.has(msg.webhookId)) {
				return;
			}

			handlers.onEdit(msg.channelId, msg.id, async () => {
				const full = msg.partial ? await msg.fetch().catch(() => null) : msg;

				// Link previews being added also fire updates; only real edits carry an edited timestamp.
				if (!full || !full.editedTimestamp || !this.isRelayable(full)) {
					return null;
				}

				return this.normalize(full);
			});
		});

		c.on(Events.MessageDelete, (msg) => {
			if (
				msg.guildId !== this.guildId ||
				!this.isMapped(msg.channelId)
			) {
				return;
			}
			
			handlers.onDelete(msg.channelId, msg.id);
		});

		c.on(Events.MessageBulkDelete, (messages, channel) => {
			if (
				channel.guildId !== this.guildId ||
				!this.isMapped(channel.id)
			) {
				return;
			}

			for (const id of messages.keys()) {
				handlers.onDelete(channel.id, id);
			}
		});

		c.on(Events.Error, (err) => log.error("client error:", err));
		c.on(Events.Warn, (msg) => log.warn(msg));

		const ready = new Promise((resolve) => c.once(Events.ClientReady, resolve));
		await c.login(this.config.secrets.discordToken);
		await ready;
		log.info(`logged in as ${c.user.tag}`);

		const guild = await c.guilds.fetch(this.guildId).catch(() => null);
		if (!guild) {
			throw new Error(`Discord bot is not a member of guild ${this.guildId}`);
		}

		this.guild = guild;

		if (this.config.secrets.discordClientId) {
			log.info(
				"invite URL: https://discord.com/oauth2/authorize?scope=bot&permissions=536939520&client_id=" + this.config.secrets.discordClientId,
			);
		}
	}

	async stop() {
		for (const wh of this.webhooks.values()) wh.destroy();

		await this.client.destroy();
	}

	/** Cheap synchronous filter: only real user messages in mapped channels, never our own output. */
	/** Whether a Discord channel is bridged. Reads the live mappings, so map/unmap apply at once. */
	isMapped(channelId) {
		return this.mappings.channel.discord.has(channelId);
	}

	isRelayable(msg) {
		if (msg.guildId !== this.guildId || !this.isMapped(msg.channelId)) return false;
		if (msg.author?.id === this.client.user?.id) return false;
		if (msg.webhookId && this.ownWebhookIds.has(msg.webhookId)) return false;
		if (msg.system || !RELAYED_TYPES.has(msg.type)) return false;

		return true;
	}

	/** Convert a discord.js Message into a platform-neutral bridge message. */
	async normalize(msg) {
		const guild = msg.guild ?? this.guild;
		let member = msg.member;

		if (!member && !msg.webhookId) {
			member = await guild.members.fetch(msg.author.id).catch(() => null);
		}

		const bridge = this.baseMessage(msg, member);

		if (msg.reference?.messageId && msg.type === MessageType.Reply) {
			const ref = await msg.fetchReference().catch(() => null);

			bridge.reference = ref
				? {
					...this.baseMessage(ref, ref.member),
					pingAuthor: msg.mentions.repliedUser != null,
				} : {
					id: msg.reference.messageId,
					missing: true
				};
		}

		return bridge;
	}

	baseMessage(msg, member) {
		const guild = msg.guild ?? this.guild;
		const author = msg.author;

		return {
			platform: "discord",
			id: msg.id,
			channelId: msg.channelId,
			author: {
				id: author.id,
				name: member?.displayName ?? author.displayName ?? author.username,
				avatarUrl: (member ?? author).displayAvatarURL({
					extension: "png",
					size: 256,
				}),
			},
			content: msg.content ?? "",
			attachments: [...msg.attachments.values()].map((a) => ({
				url: a.url,
				name: a.name.replace(/^SPOILER_/, ""),
				size: a.size,
				contentType: a.contentType,
				spoiler: a.spoiler,
			})),
			embeds: msg.embeds.map((e) => e.data),
			names: {
				users: {
					get: (id) =>
						msg.mentions.members?.get(id)?.displayName ??
						guild.members.cache.get(id)?.displayName ??
						msg.mentions.users.get(id)?.displayName ??
						this.client.users.cache.get(id)?.displayName,
				},
				roles: { get: (id) => guild.roles.cache.get(id)?.name },
				channels: { get: (id) => this.client.channels.cache.get(id)?.name },
			},
			reference: null,
		};
	}

	// ---------------------------------------------------------------- sending

	uploadLimit() {
		if (this.config.limits.discordUploadBytes) {
			return this.config.limits.discordUploadBytes;
		}

		switch (this.guild?.premiumTier) {
			case GuildPremiumTier.Tier3:
				return 100 * MiB;
			case GuildPremiumTier.Tier2:
				return 50 * MiB;
			default:
				return 10 * MiB;
		}
	}

	jumpUrl(channelId, messageId) {
		return `https://discord.com/channels/${this.guildId}/${channelId}/${messageId}`;
	}

	emojiImageUrl({ id, animated }) {
		return `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}?size=128`;
	}

	async ensureWebhook(channelId) {
		if (this.webhooks.has(channelId)) {
			return this.webhooks.get(channelId);
		}

		let stored = this.db.getWebhook("discord", channelId);

		if (!stored) {
			const channel = await this.client.channels.fetch(channelId);

			if (!channel?.createWebhook) {
				throw new Error(`Discord channel ${channelId} cannot have webhooks`);
			}

			const created = await channel.createWebhook({
				name: this.config.webhookName,
				reason: "Nartnik bridge",
			});

			stored = { id: created.id, token: created.token };
			this.db.putWebhook("discord", channelId, stored);

			log.info(`created webhook ${stored.id} in channel ${channelId}`);
		}

		this.ownWebhookIds.add(stored.id);
		const client = new WebhookClient(
			{ id: stored.id, token: stored.token },
			{ allowedMentions: { parse: [] } },
		);
		this.webhooks.set(channelId, client);

		return client;
	}

	/** Run a webhook call, recreating the webhook once if it was deleted on Discord. */
	async withWebhook(channelId, fn) {
		const webhook = await this.ensureWebhook(channelId);

		try {
			return await fn(webhook);
		} catch (err) {
			if (err.code !== RESTJSONErrorCodes.UnknownWebhook) throw err;
			log.warn(`webhook for channel ${channelId} is gone, creating a new one`);
			webhook.destroy();
			this.webhooks.delete(channelId);
			this.db.deleteWebhook("discord", channelId);
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
			wh.send({
				content: out.content || undefined,
				username: out.username,
				avatarURL: out.avatarUrl ?? undefined,
				embeds: out.embeds,
				files: out.files.map((f) => ({
					attachment: f.data,
					name: f.spoiler ? `SPOILER_${f.name}` : f.name,
				})),
				allowedMentions: {
					parse: [],
					users: out.mentionUserIds,
					repliedUser: false,
				},
			}),
		);

		return sent.id;
	}

	async edit(channelId, messageId, out) {
		await this.withWebhook(channelId, (wh) =>
			wh.editMessage(messageId, {
				content: out.content,
				embeds: out.embeds,
				allowedMentions: {
					parse: [],
					users: out.mentionUserIds,
					repliedUser: false,
				},
			}),
		).catch((err) => {
			if (err.code !== RESTJSONErrorCodes.UnknownMessage) throw err;
		});
	}

	async delete(channelId, messageId) {
		await this.withWebhook(channelId, (wh) =>
			wh.deleteMessage(messageId),
		).catch((err) => {
			if (err.code !== RESTJSONErrorCodes.UnknownMessage) throw err;
		});
	}

	// ---------------------------------------------------------------- history import

	// ---------------------------------------------------------------- lookups for map commands

	/** A channel of the bridged server as { name, webhooks }, or null when it isn't in that server. */
	async lookupChannel(channelId) {
		const channel = await this.client.channels.fetch(channelId).catch(() => null);
		if (!channel || channel.guildId !== this.guildId) return null;
		return {
			name: channel.name,
			webhooks: channel.isTextBased() && typeof channel.createWebhook === "function",
		};
	}

	/** Display name of a Discord user (server nickname when they are a member), or null if there is no such user. */
	async lookupUser(userId) {
		const member = await this.guild.members.fetch(userId).catch(() => null);
		if (member) return member.displayName;
		const user = await this.client.users.fetch(userId).catch(() => null);
		return user ? (user.displayName ?? user.username) : null;
	}

	/** Name of a role of the bridged server, or null. */
	async lookupRole(roleId) {
		const role = await this.guild.roles.fetch(roleId).catch(() => null);
		return role?.name ?? null;
	}

	/** Name of a custom emoji of the bridged server, or null. */
	async lookupEmoji(emojiId) {
		const emoji = await this.guild.emojis.fetch(emojiId).catch(() => null);
		return emoji?.name ?? null;
	}

	async channelName(channelId) {
		const channel = await this.client.channels
			.fetch(channelId)
			.catch(() => null);
		
		return channel?.name ?? channelId;
	}

	/** Fetch up to `limit` newest messages, returned oldest first. */
	async fetchNewest(channelId, limit) {
		const channel = await this.client.channels.fetch(channelId);
		const out = [];
		let before;

		while (out.length < limit) {
			const batch = await channel.messages.fetch({
				limit: Math.min(100, limit - out.length),
				before,
				cache: false,
			});

			if (batch.size === 0) break;

			out.push(...batch.values());
			before = batch.lastKey();
		}

		return out.sort(compareIds);
	}

	/** Fetch every message with oldestId <= id <= newestId, oldest first. */
	async fetchRange(channelId, oldestId, newestId) {
		const channel = await this.client.channels.fetch(channelId);
		const out = [];
		let after = (BigInt(oldestId) - 1n).toString();

		for (;;) {
			const batch = await channel.messages.fetch({
				limit: 100,
				after,
				cache: false,
			});

			if (batch.size === 0) break;

			const sorted = [...batch.values()].sort(compareIds);

			for (const msg of sorted) {
				if (BigInt(msg.id) <= BigInt(newestId)) {
					out.push(msg);
				}
			}

			after = sorted.at(-1).id;

			if (BigInt(after) >= BigInt(newestId)) break;
		}

		return out;
	}
}

function compareIds(a, b) {
	const x = BigInt(a.id);
	const y = BigInt(b.id);
	return x < y ? -1 : x > y ? 1 : 0;
}
