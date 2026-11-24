import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhooks (
	platform    TEXT NOT NULL,           -- 'discord' | 'fluxer'
	channel_id  TEXT NOT NULL,
	webhook_id  TEXT NOT NULL,
	token       TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	PRIMARY KEY (platform, channel_id)
);

-- One row per relayed message. "origin" is the platform the message was written on.
CREATE TABLE IF NOT EXISTS message_map (
	origin              TEXT NOT NULL,   -- 'discord' | 'fluxer'
	discord_channel_id  TEXT NOT NULL,
	discord_message_id  TEXT NOT NULL UNIQUE,
	fluxer_channel_id   TEXT NOT NULL,
	fluxer_message_id   TEXT NOT NULL UNIQUE,
	created_at          INTEGER NOT NULL
);

-- Bridged channels, linked users, mapped custom emoji and roles. "kind" is 'channel' | 'user' | 'emoji' | 'role'.
CREATE TABLE IF NOT EXISTS links (
	kind        TEXT NOT NULL,
	discord_id  TEXT NOT NULL,
	fluxer_id   TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	UNIQUE (kind, discord_id),
	UNIQUE (kind, fluxer_id)
);

-- Small key/value flags, e.g. whether config.yaml's mappings were imported.
CREATE TABLE IF NOT EXISTS meta (
	key    TEXT PRIMARY KEY,
	value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
	id                  INTEGER PRIMARY KEY AUTOINCREMENT,
	fluxer_channel_id   TEXT NOT NULL,
	discord_channel_id  TEXT NOT NULL,
	requested_by        TEXT NOT NULL,   -- Fluxer user ID
	total               INTEGER NOT NULL,
	done                INTEGER NOT NULL DEFAULT 0,
	oldest_discord_id   TEXT NOT NULL,   -- first message (inclusive) that belongs to this import
	newest_discord_id   TEXT NOT NULL,   -- last message (inclusive) that belongs to this import
	last_discord_id     TEXT,            -- last message handled so far
	status              TEXT NOT NULL,   -- 'running' | 'finished' | 'cancelled' | 'failed'
	created_at          INTEGER NOT NULL,
	updated_at          INTEGER NOT NULL
);
`;

const OTHER = { discord: "fluxer", fluxer: "discord" };

/** Link kinds stored in the links table, and the config.yaml list each one is seeded from. */
export const LINK_KINDS = { channel: "channels", user: "users", emoji: "emoji", role: "roles" };
const CONFIG_SEEDED = "config_links_imported";

export function openDatabase(path) {
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}

	let db;
	try {
		db = new Database(path);
		db.pragma("journal_mode = WAL");
		db.pragma("busy_timeout = 5000");
		db.exec(SCHEMA);
	} catch (err) {
		db?.close();
		if (/^SQLITE_(READONLY|CANTOPEN)/.test(err.code ?? "") || err.code === "EACCES") {
			const user = process.getuid ? ` (user ID ${process.getuid()})` : "";
			throw new Error(
				`Cannot write the database at ${path}: ${err.message} [${err.code}]. The bot${user} needs write access ` +
					`to both the file and its folder, because SQLite creates -wal and -shm files next to it. ` +
					`In Docker: chown -R 1000:1000 data`,
				{ cause: err },
			);
		}
		throw err;
	}

	return createStore(db);
}

function createStore(db) {
	const q = {
		getWebhook: db.prepare(
			"SELECT webhook_id AS id, token FROM webhooks WHERE platform = ? AND channel_id = ?",
		),
		putWebhook: db.prepare(`
			INSERT INTO webhooks
				(platform, channel_id, webhook_id, token, created_at)
			VALUES
				(?, ?, ?, ?, ?)
			ON CONFLICT (platform, channel_id) DO
				UPDATE SET webhook_id = excluded.webhook_id, token = excluded.token, created_at = excluded.created_at`
		),
		deleteWebhook: db.prepare(
			"DELETE FROM webhooks WHERE platform = ? AND channel_id = ?",
		),
		allWebhookIds: db.prepare(
			"SELECT platform, webhook_id AS id FROM webhooks",
		),

		putPair: db.prepare(`
      		INSERT OR REPLACE INTO message_map
				(origin, discord_channel_id, discord_message_id, fluxer_channel_id, fluxer_message_id, created_at)
      		VALUES
				(@origin, @discordChannelId, @discordMessageId, @fluxerChannelId, @fluxerMessageId, @createdAt)`
		),
		pairByDiscord: db.prepare(
			"SELECT * FROM message_map WHERE discord_message_id = ?",
		),
		pairByFluxer: db.prepare(
			"SELECT * FROM message_map WHERE fluxer_message_id = ?",
		),
		deletePairByDiscord: db.prepare(
			"DELETE FROM message_map WHERE discord_message_id = ?",
		),
		deletePairByFluxer: db.prepare(
			"DELETE FROM message_map WHERE fluxer_message_id = ?",
		),

		links: db.prepare(
			"SELECT discord_id AS discord, fluxer_id AS fluxer FROM links WHERE kind = ? ORDER BY rowid",
		),
		addLink: db.prepare(
			"INSERT OR IGNORE INTO links (kind, discord_id, fluxer_id, created_at) VALUES (?, ?, ?, ?)",
		),
		removeLink: db.prepare(
			"DELETE FROM links WHERE kind = ? AND (discord_id = ? OR fluxer_id = ?)",
		),
		getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
		setMeta: db.prepare(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
		),

		createImport: db.prepare(`
      		INSERT INTO imports
				(fluxer_channel_id, discord_channel_id, requested_by, total, oldest_discord_id, newest_discord_id, status, created_at, updated_at)
      		VALUES
				(@fluxerChannelId, @discordChannelId, @requestedBy, @total, @oldestDiscordId, @newestDiscordId, 'running', @now, @now)`
		),
		progressImport: db.prepare(
			"UPDATE imports SET done = done + 1, last_discord_id = ?, updated_at = ? WHERE id = ?",
		),
		finishImport: db.prepare(
			"UPDATE imports SET status = ?, updated_at = ? WHERE id = ?",
		),
		getImport: db.prepare(
			"SELECT * FROM imports WHERE id = ?"
		),
		runningImports: db.prepare(
			"SELECT * FROM imports WHERE status = 'running' ORDER BY id",
		),
		runningImportForChannel: db.prepare(
			"SELECT * FROM imports WHERE status = 'running' AND fluxer_channel_id = ?",
		),
	};

	const rowToPair = (row) =>
		row && {
			origin: row.origin,
			discord: {
				channelId: row.discord_channel_id,
				messageId: row.discord_message_id,
			},
			fluxer: {
				channelId: row.fluxer_channel_id,
				messageId: row.fluxer_message_id,
			},
		};

	const rowToImport = (row) =>
		row && {
			id: row.id,
			fluxerChannelId: row.fluxer_channel_id,
			discordChannelId: row.discord_channel_id,
			requestedBy: row.requested_by,
			total: row.total,
			done: row.done,
			oldestDiscordId: row.oldest_discord_id,
			newestDiscordId: row.newest_discord_id,
			lastDiscordId: row.last_discord_id,
			status: row.status,
		};

	const addLink = (kind, discordId, fluxerId) => {
		if (!(kind in LINK_KINDS)) throw new Error(`Unknown link kind "${kind}"`);
		return q.addLink.run(kind, discordId, fluxerId, Date.now()).changes > 0;
	};

	/**
	 * Import config.yaml's channels/users/emoji lists into the links table, once. The flag is set in the same
	 * transaction, so later starts skip this even if config.yaml still lists pairs.
	 * @returns {{channel:number,user:number,emoji:number,role:number}|null} rows added per kind, or null if already imported
	 */
	const seedLinksFromConfig = db.transaction((config) => {
		if (q.getMeta.get(CONFIG_SEEDED)) return null;
		const added = {};
		for (const [kind, key] of Object.entries(LINK_KINDS)) {
			added[kind] = 0;
			for (const pair of config[key] ?? []) {
				if (addLink(kind, pair.discord, pair.fluxer)) added[kind]++;
			}
		}
		q.setMeta.run(CONFIG_SEEDED, new Date().toISOString());
		return added;
	});

	return {
		raw: db,
		close: () => db.close(),

		// --- channel / user / emoji links ---
		/** All pairs of one kind, as [{ discord, fluxer }]. */
		links: (kind) => q.links.all(kind),

		/** Channel, user, emoji and role pairs, as lists of { discord, fluxer }. */
		allLinks: () => ({
			channels: q.links.all("channel"),
			users: q.links.all("user"),
			emoji: q.links.all("emoji"),
			roles: q.links.all("role"),
		}),

		/** Add a pair. Returns false if either ID is already linked for this kind. */
		addLink,

		/** Remove the pair containing `id` (Discord or Fluxer side). Returns true if a row was deleted. */
		removeLink: (kind, id) => q.removeLink.run(kind, id, id).changes > 0,

		seedLinksFromConfig,
		linksSeededFromConfig: () => Boolean(q.getMeta.get(CONFIG_SEEDED)),

		// --- webhooks ---
		getWebhook: (platform, channelId) =>
			q.getWebhook.get(platform, channelId) ?? null,

		putWebhook: (platform, channelId, webhook) =>
			q.putWebhook.run(
				platform,
				channelId,
				webhook.id,
				webhook.token,
				Date.now(),
			),

		deleteWebhook: (platform, channelId) =>
			q.deleteWebhook.run(platform, channelId),

		webhookIds: (platform) =>
			new Set(
				q.allWebhookIds
					.all()
					.filter((r) => r.platform === platform)
					.map((r) => r.id),
			),

		// --- message map ---
		/**
		 * Record a relayed message.
		 * @param {'discord'|'fluxer'} origin platform the message was written on
		 * @param {{channelId:string,messageId:string}} discord
		 * @param {{channelId:string,messageId:string}} fluxer
		 */
		putPair: (origin, discord, fluxer) =>
			q.putPair.run({
				origin,
				discordChannelId: discord.channelId,
				discordMessageId: discord.messageId,
				fluxerChannelId: fluxer.channelId,
				fluxerMessageId: fluxer.messageId,
				createdAt: Date.now(),
			}),

		/** Find the pair a message belongs to, whether it is the original or the mirror. */
		findPair: (platform, messageId) =>
			rowToPair(
				platform === "discord"
					? q.pairByDiscord.get(messageId)
					: q.pairByFluxer.get(messageId),
			) ?? null,

		/** The counterpart of `messageId` (on `platform`) on the other platform, or null. */
		counterpart(platform, messageId) {
			const pair = this.findPair(platform, messageId);
			return pair ? pair[OTHER[platform]] : null;
		},

		deletePair: (platform, messageId) =>
			(platform === "discord"
				? q.deletePairByDiscord
				: q.deletePairByFluxer
			).run(messageId),

		// --- imports ---
		createImport: (data) =>
			Number(q.createImport.run({ ...data, now: Date.now() }).lastInsertRowid),

		progressImport: (id, discordMessageId) =>
			q.progressImport.run(discordMessageId, Date.now(), id),

		finishImport: (id, status) => q.finishImport.run(status, Date.now(), id),

		getImport: (id) => rowToImport(q.getImport.get(id)) ?? null,

		runningImports: () => q.runningImports.all().map(rowToImport),

		runningImportForChannel: (fluxerChannelId) =>
			rowToImport(q.runningImportForChannel.get(fluxerChannelId)) ?? null,
	};
}
