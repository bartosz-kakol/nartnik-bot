import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { KeyedQueue, Relay } from "../src/core/relay.js";
import { FakeAdapter, bridgeMessage, fakeFetch, testConfig } from "./fakes.js";

let db;
let discord;
let fluxer;
let relay;

beforeEach(() => {
	db = openDatabase(":memory:");
	discord = new FakeAdapter("discord");
	fluxer = new FakeAdapter("fluxer", { uploadLimit: 5 });
	relay = new Relay({
		config: testConfig(),
		db,
		adapters: { discord, fluxer },
		fetch: fakeFetch,
	});
	relay.markReady();
});

const prepared = (msg) => () => Promise.resolve(msg);

test("KeyedQueue runs jobs per key in order and isolates failures", async () => {
	const q = new KeyedQueue();
	const order = [];
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const a = q.push("k", async () => {
		await sleep(20);
		order.push(1);
	});
	const b = q.push("k", async () => {
		throw new Error("boom");
	});
	const c = q.push("k", async () => {
		order.push(3);
		return "c";
	});
	const other = q.push("other", async () => {
		order.push("x");
	});
	await assert.rejects(b, /boom/);
	assert.equal(await c, "c");
	await a;
	await other;
	assert.deepEqual(order, ["x", 1, 3]);
	assert.equal(q.size("k"), 0);
});

test("jobs wait until the relay is marked ready", async () => {
	const r = new Relay({
		config: testConfig(),
		db,
		adapters: { discord, fluxer },
		fetch: fakeFetch,
	});
	const done = r.onMessage(
		"discord",
		"110000",
		prepared(bridgeMessage("discord")),
	);
	await new Promise((res) => setTimeout(res, 10));
	assert.equal(fluxer.sent.length, 0);
	r.markReady();
	await done;
	assert.equal(fluxer.sent.length, 1);
});

test("relays a Discord message to Fluxer with disguise and records the pair", async () => {
	const msg = bridgeMessage("discord", { content: "hi <@1>" });
	await relay.onMessage("discord", "110000", prepared(msg));
	assert.equal(fluxer.sent.length, 1);
	const out = fluxer.sent[0];
	assert.equal(out.channelId, "210000");
	assert.equal(out.username, "Alice");
	assert.equal(out.avatarUrl, "https://avatar");
	assert.equal(out.content, "hi <@9001>");
	assert.deepEqual(out.mentionUserIds, ["9001"]);
	assert.deepEqual(db.counterpart("discord", msg.id), {
		channelId: "210000",
		messageId: out.id,
	});
	assert.equal(db.findPair("fluxer", out.id).origin, "discord");
});

test("messages in unmapped channels are ignored", async () => {
	await relay.onMessage(
		"discord",
		"999999",
		prepared(bridgeMessage("discord", { channelId: "999999" })),
	);
	assert.equal(fluxer.sent.length, 0);
});

test("preserves order even when preparation times differ", async () => {
	const slow = () =>
		new Promise((r) =>
			setTimeout(() => r(bridgeMessage("discord", { content: "first" })), 30),
		);
	const fast = prepared(bridgeMessage("discord", { content: "second" }));
	await Promise.all([
		relay.onMessage("discord", "110000", slow),
		relay.onMessage("discord", "110000", fast),
	]);
	assert.deepEqual(
		fluxer.sent.map((s) => s.content),
		["first", "second"],
	);
});

test("edits and deletes of the original reach the mirror; mirror events do not loop", async () => {
	const msg = bridgeMessage("fluxer", { content: "v1" });
	await relay.onMessage("fluxer", "210000", prepared(msg));
	const mirrorId = discord.sent[0].id;

	await relay.onEdit(
		"fluxer",
		"210000",
		msg.id,
		prepared({ ...msg, content: "v2" }),
	);
	assert.deepEqual(
		discord.edited.map((e) => [e.messageId, e.content]),
		[[mirrorId, "v2"]],
	);

	// An edit event for the mirror itself (on Discord) must not be relayed back.
	await relay.onEdit(
		"discord",
		"110000",
		mirrorId,
		prepared(bridgeMessage("discord", { id: mirrorId })),
	);
	assert.equal(fluxer.edited.length, 0);

	await relay.onDelete("fluxer", "210000", msg.id);
	assert.deepEqual(discord.deleted, [
		{ channelId: "110000", messageId: mirrorId },
	]);
	assert.equal(db.findPair("fluxer", msg.id), null);
});

test("deleting a mirror only forgets the pair", async () => {
	const msg = bridgeMessage("discord");
	await relay.onMessage("discord", "110000", prepared(msg));
	await relay.onDelete("fluxer", "210000", fluxer.sent[0].id);
	assert.equal(discord.deleted.length, 0);
	assert.equal(db.findPair("discord", msg.id), null);
});

test("reply to a known message: real reply on Fluxer", async () => {
	const original = bridgeMessage("discord", { content: "question" });
	await relay.onMessage("discord", "110000", prepared(original));
	const reply = bridgeMessage("discord", {
		content: "answer",
		reference: { ...original, pingAuthor: true },
	});
	await relay.onMessage("discord", "110000", prepared(reply));
	const out = fluxer.sent[1];
	assert.deepEqual(out.reply, { messageId: fluxer.sent[0].id, ping: true });
	assert.equal(out.content, "answer");
});

test("reply on Fluxer becomes a quote line with jump link on Discord", async () => {
	// The replied-to message was originally written on Discord and mirrored to Fluxer.
	const original = bridgeMessage("discord", { content: "question <@1>" });
	await relay.onMessage("discord", "110000", prepared(original));
	const mirrorOnFluxer = fluxer.sent[0].id;
	const reply = bridgeMessage("fluxer", {
		content: "answer",
		reference: {
			...bridgeMessage("fluxer", {
				id: mirrorOnFluxer,
				content: "question <@9001>",
			}),
			author: { name: "Bob" },
		},
	});
	reply.reference.names = { users: new Map([["9001", "Linky"]]) };
	await relay.onMessage("fluxer", "210000", prepared(reply));
	const out = discord.sent[0];
	assert.equal(out.reply, null);
	assert.equal(
		out.content,
		`> ↪ **Bob**: question @Linky [jump](<https://discord.test/110000/${original.id}>)\nanswer`,
	);
	assert.deepEqual(out.mentionUserIds, [], "quoted mentions never ping");
});

test("reply to an unknown message falls back to a quote line without link", async () => {
	const reply = bridgeMessage("discord", {
		content: "answer",
		reference: bridgeMessage("discord", {
			content: "old stuff",
			author: { name: "Old" },
		}),
	});
	await relay.onMessage("discord", "110000", prepared(reply));
	assert.equal(fluxer.sent[0].reply, null);
	assert.equal(fluxer.sent[0].content, "> ↪ **Old**: old stuff\nanswer");
});

test("attachments: upload what fits, link the rest, keep spoilers", async () => {
	const msg = bridgeMessage("discord", {
		content: "",
		attachments: [
			{ url: "https://cdn/a.png", name: "a.png", size: 3, spoiler: true },
			{ url: "https://cdn/big.zip", name: "big.zip", size: 50, spoiler: false },
			{
				url: "https://cdn/missing.txt",
				name: "gone.txt",
				size: 1,
				spoiler: false,
			},
		],
	});
	await relay.onMessage("discord", "110000", prepared(msg));
	const out = fluxer.sent[0];
	assert.deepEqual(
		out.files.map((f) => [f.name, f.spoiler, f.data.length]),
		[["a.png", true, 3]],
	);
	assert.equal(
		out.content,
		"📎 big.zip: https://cdn/big.zip\n📎 gone.txt: https://cdn/missing.txt",
	);
});

test("a lone unmapped custom emoji is sent as an image", async () => {
	const msg = bridgeMessage("discord", { content: "<:blob:777777>" });
	await relay.onMessage("discord", "110000", prepared(msg));
	const out = fluxer.sent[0];
	assert.equal(out.content, "");
	assert.deepEqual(
		out.files.map((f) => f.name),
		["blob.png"],
	);
});

test("lone emoji falls back to text when the image cannot be fetched", async () => {
	discord.emojiImageUrl = () => "https://discord.test/missing";
	await relay.onMessage(
		"discord",
		"110000",
		prepared(bridgeMessage("discord", { content: "<:blob:777777>" })),
	);
	assert.equal(fluxer.sent[0].content, ":blob:");
});

test("empty messages are skipped", async () => {
	await relay.onMessage(
		"discord",
		"110000",
		prepared(bridgeMessage("discord", { content: "   " })),
	);
	assert.equal(fluxer.sent.length, 0);
});

test("ping_linked_users: false keeps mentions but pings nobody", async () => {
	relay.config.pingLinkedUsers = false;
	await relay.onMessage(
		"discord",
		"110000",
		prepared(bridgeMessage("discord", { content: "<@1>" })),
	);
	assert.equal(fluxer.sent[0].content, "<@9001>");
	assert.deepEqual(fluxer.sent[0].mentionUserIds, []);
});

test("a failed send does not block later messages", async () => {
	fluxer.failNextSend = new Error("HTTP 500");
	await relay.onMessage(
		"discord",
		"110000",
		prepared(bridgeMessage("discord", { content: "lost" })),
	);
	await relay.onMessage(
		"discord",
		"110000",
		prepared(bridgeMessage("discord", { content: "next" })),
	);
	assert.deepEqual(
		fluxer.sent.map((s) => s.content),
		["next"],
	);
});
