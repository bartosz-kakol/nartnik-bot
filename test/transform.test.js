import { test } from "node:test";
import assert from "node:assert/strict";
import {
	clip,
	pairMaps,
	planAttachments,
	replyQuoteLine,
	snippet,
	soloUnmappedEmoji,
	toWireEmbed,
	transformContent,
	webhookUsername,
} from "../src/core/transform.js";

const ctx = (from, extra = {}) => ({
	from,
	users: pairMaps([{ discord: "111111", fluxer: "911111" }]),
	channels: pairMaps([{ discord: "222222", fluxer: "922222" }]),
	emoji: pairMaps([{ discord: "333333", fluxer: "933333" }]),
	roles: pairMaps([{ discord: "555556", fluxer: "955556" }]),
	names: {
		users: new Map([
			["444444", "Alice"],
			["111111", "Linked"],
		]),
		roles: new Map([["555555", "Mods"]]),
		channels: new Map([["666666", "off-topic"]]),
	},
	...extra,
});

test("linked user mentions become real mentions on the other side", () => {
	const r = transformContent("hi <@111111> and <@!111111>", ctx("discord"));
	assert.equal(r.content, "hi <@911111> and <@911111>");
	assert.deepEqual(r.mentionedUserIds, ["911111"]);
});

test("works in the Fluxer -> Discord direction too", () => {
	const r = transformContent("<@911111> <#922222> <:x:933333>", ctx("fluxer"));
	assert.equal(r.content, "<@111111> <#222222> <:x:333333>");
});

test("unlinked users, roles and unmapped channels become plain text", () => {
	const r = transformContent(
		"<@444444> <@&555555> <#666666> <@777777>",
		ctx("discord"),
	);
	assert.equal(r.content, "@Alice @Mods #off-topic @unknown-user");
	assert.deepEqual(r.mentionedUserIds, []);
});

test("mapped roles become real role mentions, unmapped ones @name", () => {
	assert.equal(
		transformContent("<@&555556> <@&555555>", ctx("discord")).content,
		"<@&955556> @Mods",
	);
	assert.equal(transformContent("<@&955556>", ctx("fluxer")).content, "<@&555556>");
});

test("linkUsers: false never produces a real mention", () => {
	const r = transformContent("<@111111>", ctx("discord", { linkUsers: false }));
	assert.equal(r.content, "@Linked");
	assert.deepEqual(r.mentionedUserIds, []);
});

test("mapped emoji convert, unmapped ones become :name:", () => {
	const r = transformContent(
		"<:yes:333333> <a:dance:999999> 🙂",
		ctx("discord"),
	);
	assert.equal(r.content, "<:yes:933333> :dance: 🙂");
});

test("code spans and blocks are left untouched", () => {
	const r = transformContent(
		"`<@444444>` ```\n<:a:999999>\n``` <@444444>",
		ctx("discord"),
	);
	assert.equal(r.content, "`<@444444>` ```\n<:a:999999>\n``` @Alice");
});

test("slash command mentions become plain /name", () => {
	assert.equal(
		transformContent("use </ping:123456789>", ctx("discord")).content,
		"use /ping",
	);
});

test("soloUnmappedEmoji only matches a single unmapped custom emoji", () => {
	const emoji = pairMaps([{ discord: "333333", fluxer: "933333" }]);
	assert.deepEqual(soloUnmappedEmoji("  <a:dance:999999> ", "discord", emoji), {
		id: "999999",
		name: "dance",
		animated: true,
	});
	assert.equal(soloUnmappedEmoji("<:yes:333333>", "discord", emoji), null);
	assert.equal(soloUnmappedEmoji("<:a:999999> hi", "discord", emoji), null);
	assert.equal(
		soloUnmappedEmoji("<:a:999999><:b:888888>", "discord", emoji),
		null,
	);
	assert.equal(soloUnmappedEmoji("", "discord", emoji), null);
});

test("snippet flattens and shortens", () => {
	assert.equal(snippet("> quoted\nline  two"), "quoted line two");
	assert.equal(snippet("a".repeat(150)).length, 100);
	assert.ok(snippet("a".repeat(150)).endsWith("…"));
	assert.equal(snippet("```js\ncode\n``` after"), "[code] after");
});

test("replyQuoteLine with and without jump link", () => {
	assert.equal(
		replyQuoteLine({ authorName: "Bob", text: "hey" }),
		"> ↪ **Bob**: hey",
	);
	assert.equal(
		replyQuoteLine({
			authorName: "a_b",
			text: "x",
			jumpUrl: "https://discord.com/channels/1/2/3",
		}),
		"> ↪ **a\\_b**: x [jump](<https://discord.com/channels/1/2/3>)",
	);
});

test("webhookUsername sanitises for Discord", () => {
	assert.equal(webhookUsername("My Discord Pal", "discord"), "My Disc​ord Pal");
	assert.equal(webhookUsername("My Discord Pal", "fluxer"), "My Discord Pal");
	assert.equal(webhookUsername("   ", "fluxer"), "Unknown");
	assert.equal(webhookUsername("x".repeat(100), "fluxer").length, 80);
});

test("clip keeps content within the limit", () => {
	assert.equal(clip("abc", 5), "abc");
	assert.equal(clip("abcdef", 5), "abcd…");
});

test("planAttachments uploads what fits and links the rest", () => {
	const att = (name, size) => ({ name, size, url: `https://x/${name}` });
	const { upload, link } = planAttachments(
		[att("a", 6), att("b", 6), att("c", 3), att("d", Infinity)],
		10,
	);
	assert.deepEqual(
		upload.map((a) => a.name),
		["a", "c"],
	);
	assert.deepEqual(
		link.map((a) => a.name),
		["b", "d"],
	);
});

test("toWireEmbed keeps rich embeds and drops generated previews", () => {
	assert.equal(toWireEmbed({ type: "link", url: "https://x" }), null);
	assert.equal(toWireEmbed({ type: "rich" }), null);
	// Fluxer-style camelCase input
	assert.deepEqual(
		toWireEmbed({
			type: "rich",
			title: "T",
			color: 5,
			timestamp: new Date("2026-01-01T00:00:00Z"),
			author: { name: "A", iconUrl: "https://i" },
			footer: { text: "F", iconUrl: null },
			image: { url: "https://img", proxyUrl: "https://p" },
			fields: [{ name: "n", value: "v", inline: false }],
		}),
		{
			title: "T",
			color: 5,
			timestamp: "2026-01-01T00:00:00.000Z",
			author: { name: "A", icon_url: "https://i" },
			footer: { text: "F" },
			image: { url: "https://img" },
			fields: [{ name: "n", value: "v", inline: false }],
		},
	);
});
