// Test doubles for platform adapters.

let nextId = 5000;

export class FakeAdapter {
	constructor(name, { uploadLimit = 10 * 1024 * 1024 } = {}) {
		this.name = name;
		this.sent = [];
		this.edited = [];
		this.deleted = [];
		this.limit = uploadLimit;
		this.failNextSend = null;
	}

	uploadLimit() {
		return this.limit;
	}

	jumpUrl(channelId, messageId) {
		return `https://${this.name}.test/${channelId}/${messageId}`;
	}

	emojiImageUrl({ id }) {
		return `https://${this.name}.test/emoji/${id}`;
	}

	async ensureWebhook() {}

	async send(channelId, out) {
		if (this.failNextSend) {
			const err = this.failNextSend;
			this.failNextSend = null;
			throw err;
		}
		const id = String(nextId++);
		this.sent.push({ channelId, id, ...out });
		return id;
	}

	async edit(channelId, messageId, out) {
		this.edited.push({ channelId, messageId, ...out });
	}

	async delete(channelId, messageId) {
		this.deleted.push({ channelId, messageId });
	}
}

/** A minimal bridge message. */
export function bridgeMessage(platform, overrides = {}) {
	return {
		platform,
		id: String(nextId++),
		channelId: platform === "discord" ? "110000" : "210000",
		author: { id: "1", name: "Alice", avatarUrl: "https://avatar" },
		content: "hello",
		attachments: [],
		embeds: [],
		names: { users: new Map(), roles: new Map(), channels: new Map() },
		reference: null,
		...overrides,
	};
}

/** fetch() stand-in that returns a small body for any URL, or 404 for URLs containing "missing". */
export async function fakeFetch(url) {
	if (String(url).includes("missing"))
		return new Response("nope", { status: 404 });
	return new Response(new Uint8Array([1, 2, 3]));
}

export function testConfig(overrides = {}) {
	return {
		commandPrefix: "!",
		pingLinkedUsers: true,
		fluxer: { guildId: "200000", privilegedRoleIds: ["300000"] },
		discord: { guildId: "100000" },
		import: { maxMessages: 100, confirmTimeoutMs: 60_000 },
		channels: [{ discord: "110000", fluxer: "210000" }],
		users: [{ discord: "1", fluxer: "9001" }],
		emoji: [],
		...overrides,
	};
}
