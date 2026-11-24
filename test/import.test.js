import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { Relay } from "../src/core/relay.js";
import { Importer } from "../src/core/import.js";
import { FakeAdapter, bridgeMessage, fakeFetch, testConfig } from "./fakes.js";

let db;
let discord;
let fluxer;
let relay;
let importer;

// Raw Discord messages, oldest first. IDs increase with time like snowflakes.
const history = Array.from({ length: 5 }, (_, i) => ({
	id: String(1000 + i),
	createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
	content: `old ${i}`,
	relayable: i !== 2, // pretend #2 is a system message
}));

beforeEach(() => {
	db = openDatabase(":memory:");
	discord = Object.assign(new FakeAdapter("discord"), {
		fetchNewest: async (_channelId, limit) => history.slice(-limit),
		fetchRange: async (_c, oldest, newest) =>
			history.filter((m) => m.id >= oldest && m.id <= newest),
		isRelayable: (m) => m.relayable,
		normalize: async (m) =>
			bridgeMessage("discord", { id: m.id, content: m.content }),
		channelName: async () => "general",
	});
	fluxer = Object.assign(new FakeAdapter("fluxer"), {
		posts: [],
		reactions: [],
		roles: { 42: ["300000"], 43: [] },
		post: async (channelId, content, opts = {}) => {
			const id = `post${fluxer.posts.length}`;
			fluxer.posts.push({ channelId, content, id, ...opts });
			return id;
		},
		react: async (channelId, messageId, emoji) =>
			fluxer.reactions.push({ messageId, emoji }),
		memberRoleIds: async (userId) => fluxer.roles[userId] ?? [],
	});
	const config = testConfig();
	relay = new Relay({
		config,
		db,
		adapters: { discord, fluxer },
		fetch: fakeFetch,
	});
	relay.markReady();
	importer = new Importer({ config, db, relay, discord, fluxer });
});

const command = (content, userId = "42", channelId = "210000") => ({
	id: `cmd-${Math.random()}`,
	channelId,
	content,
	author: { id: userId, username: `user${userId}`, globalName: null },
});

async function runCommand(msg) {
	assert.equal(importer.handleCommand(msg), true);
	await new Promise((r) => setTimeout(r, 10));
}

test("ignores other commands", () => {
	assert.equal(importer.handleCommand(command("!help")), false);
	assert.equal(importer.handleCommand(command("! help")), false);
	assert.equal(importer.handleCommand(command("!importer 5")), false);
});

test("accepts a space between the prefix and the command", async () => {
	await runCommand(command("! import", "43"));
	assert.match(fluxer.posts.at(-1).content, /not allowed/);
});

test("refuses members without a privileged role", async () => {
	await runCommand(command("!import 5", "43"));
	assert.match(fluxer.posts[0].content, /not allowed/);
	assert.equal(importer.pending.size, 0);
});

test("validates the argument", async () => {
	await runCommand(command("!import lots"));
	assert.match(fluxer.posts[0].content, /Usage/);
	await runCommand(command("!import 101"));
	assert.match(fluxer.posts[1].content, /most I can import at once is 100/);
});

test("refuses in channels without a Discord counterpart", async () => {
	await runCommand(command("!import 5", "42", "999999"));
	assert.match(fluxer.posts[0].content, /not bridged/);
});

test("full flow: summary, only the starter can confirm, ordered import, finish report", async () => {
	// One message was already live-relayed and must not be imported twice.
	db.putPair(
		"discord",
		{ channelId: "110000", messageId: "1004" },
		{ channelId: "210000", messageId: "x" },
	);

	await runCommand(command("!import 5"));
	const summary = fluxer.posts[0];
	assert.match(summary.content, /3 message\(s\) to import/);
	assert.match(summary.content, /2 message\(s\) skipped/);
	assert.deepEqual(fluxer.reactions, [{ messageId: summary.id, emoji: "✅" }]);

	importer.handleReaction({ messageId: summary.id, userId: "99", emoji: "✅" }); // someone else
	importer.handleReaction({ messageId: summary.id, userId: "42", emoji: "👍" }); // wrong emoji
	assert.equal(importer.pending.size, 1);

	importer.handleReaction({ messageId: summary.id, userId: "42", emoji: "✅" });
	assert.equal(importer.pending.size, 0);
	await relay.queue.drain();

	assert.deepEqual(
		fluxer.sent.map((s) => s.content),
		["old 0", "old 1", "old 3"],
	);
	for (const id of ["1000", "1001", "1003"])
		assert.ok(db.findPair("discord", id), `pair for ${id}`);
	assert.match(
		fluxer.posts.at(-1).content,
		/Import finished: 3 message\(s\) imported/,
	);
	const [imp] = db.raw.prepare("SELECT * FROM imports").all();
	assert.equal(imp.status, "finished");
	assert.equal(imp.done, 3);
});

test("resume continues a running import, skipping what was already imported", async () => {
	const id = db.createImport({
		fluxerChannelId: "210000",
		discordChannelId: "110000",
		requestedBy: "42",
		total: 4,
		oldestDiscordId: "1000",
		newestDiscordId: "1003",
	});
	db.putPair(
		"discord",
		{ channelId: "110000", messageId: "1000" },
		{ channelId: "210000", messageId: "y" },
	);
	await importer.resume();
	await relay.queue.drain();
	assert.deepEqual(
		fluxer.sent.map((s) => s.content),
		["old 1", "old 3"],
	);
	assert.equal(db.getImport(id).status, "finished");
});

test("cancel stops a running import", async () => {
	await runCommand(command("!import 5"));
	const summaryId = fluxer.posts[0].id;
	importer.handleReaction({ messageId: summaryId, userId: "42", emoji: "✅" });
	await runCommand(command("!import cancel"));
	await relay.queue.drain();
	assert.ok(fluxer.sent.length < 4);
	assert.equal(db.runningImports().length, 0);
});
