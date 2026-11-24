import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { Mappings } from "../src/core/mappings.js";
import { Mapper } from "../src/core/mapper.js";
import { Relay } from "../src/core/relay.js";
import { FakeAdapter, bridgeMessage, fakeFetch, testConfig } from "./fakes.js";

let db;
let mappings;
let discord;
let fluxer;
let mapper;
let importActive;

// What exists on each platform.
const discordChannels = { 110000: "general", 120000: "memes", 130000: "rules-forum" };
const discordUsers = { 500001: "Alice", 500002: "Bob" };
const discordEmoji = { 600001: "pog" };
const discordRoles = { 700001: "Mods" };
const fluxerMembers = new Set(["9001", "9002"]);
const fluxerRoles = { 800001: "Moderators" };

beforeEach(() => {
	db = openDatabase(":memory:");
	mappings = new Mappings({ db });
	importActive = new Set();
	discord = Object.assign(new FakeAdapter("discord"), {
		webhooksFor: [],
		lookupChannel: async (id) =>
			discordChannels[id]
				? { name: discordChannels[id], webhooks: !discordChannels[id].endsWith("forum") }
				: null,
		lookupUser: async (id) => discordUsers[id] ?? null,
		lookupEmoji: async (id) => discordEmoji[id] ?? null,
		lookupRole: async (id) => discordRoles[id] ?? null,
		ensureWebhook: async (id) => discord.webhooksFor.push(id),
	});
	fluxer = Object.assign(new FakeAdapter("fluxer"), {
		posts: [],
		webhooksFor: [],
		post: async (channelId, content, opts) => fluxer.posts.push({ channelId, content, ...opts }),
		memberRoleIds: async (userId) => (userId === "42" ? ["300000"] : []),
		isMember: async (id) => fluxerMembers.has(id),
		lookupRole: async (id) => fluxerRoles[id] ?? null,
		ensureWebhook: async (id) => fluxer.webhooksFor.push(id),
	});
	mapper = new Mapper({
		config: testConfig({ commandPrefix: "$nk" }),
		mappings,
		importer: { activeIn: (id) => importActive.has(id) },
		discord,
		fluxer,
	});
});

/** Run a command as a privileged member (or `userId`) in Fluxer channel `channelId`; resolves with the reply. */
function run(content, { channelId = "210000", userId = "42" } = {}) {
	const [name, ...args] = content.replace(/^\$nk\s*/, "").split(/\s+/);
	return mapper.run({ id: "cmd", channelId, content, author: { id: userId } }, name, args);
}

test("recognises map and unmap, with or without a space after the prefix", () => {
	const msg = (content) => ({ id: "c", channelId: "210000", content, author: { id: "42" } });
	assert.equal(mapper.handleCommand(msg("$nk map")), true);
	assert.equal(mapper.handleCommand(msg("$nkunmap")), true);
	assert.equal(mapper.handleCommand(msg("$nk import 5")), false);
	assert.equal(mapper.handleCommand(msg("$nk mapping")), false);
	assert.equal(mapper.handleCommand(msg("map channel 1")), false);
});

test("only privileged members can change mappings", async () => {
	assert.match(await run("$nk map channel 110000", { userId: "43" }), /not allowed/);
	assert.equal(mappings.channel.fluxer.size, 0);
});

test("map channel bridges the current channel, sets up webhooks and is saved", async () => {
	assert.equal(await run("$nk map channel 110000"), "Bridged this channel with #general on Discord.");
	assert.equal(mappings.channel.fluxer.get("210000"), "110000");
	assert.deepEqual([discord.webhooksFor, fluxer.webhooksFor], [["110000"], ["210000"]]);
	assert.deepEqual(db.links("channel"), [{ discord: "110000", fluxer: "210000" }]);
	// replies quote the command and never ping
	assert.equal(fluxer.posts[0].replyTo, "cmd");
});

test("map channel refuses duplicates, unknown channels and channels without webhooks", async () => {
	await run("$nk map channel 110000");
	assert.match(await run("$nk map channel 120000"), /already bridged with #general.*\$nk unmap/);
	assert.match(await run("$nk map channel 110000", { channelId: "220000" }), /already bridged with <#210000>/);
	assert.match(await run("$nk map channel 199999", { channelId: "220000" }), /no channel 199999/);
	assert.match(await run("$nk map channel 130000", { channelId: "220000" }), /pick a text channel/);
	assert.match(await run("$nk map channel", { channelId: "220000" }), /Usage/);
	assert.equal(mappings.channel.fluxer.size, 1);
});

test("map channel saves nothing when webhook setup fails", async () => {
	fluxer.ensureWebhook = async () => {
		throw new Error("Missing Permissions");
	};
	assert.match(await run("$nk map channel 110000"), /Couldn't set up webhooks \(Missing Permissions\)/);
	assert.equal(mappings.channel.fluxer.size, 0);
	assert.deepEqual(db.links("channel"), []);
});

test("map user links a mentioned Fluxer member with a Discord user", async () => {
	assert.equal(await run("$nk map user <@9001> 500001"), "Linked <@9001> with Discord user **Alice**.");
	assert.equal(mappings.user.discord.get("500001"), "9001");
	assert.match(await run("$nk map user <@!9001> 500002"), /already linked with Discord user \*\*Alice\*\*/);
	assert.match(await run("$nk map user <@9002> 500001"), /already linked with <@9001>/);
	assert.match(await run("$nk map user <@9003> 500002"), /isn't a member/);
	assert.match(await run("$nk map user <@9002> 599999"), /no Discord user/);
	assert.match(await run("$nk map user 500002"), /Usage/);
});

test("map emoji takes a literal Fluxer emoji", async () => {
	assert.equal(await run("$nk map emoji <:pog:9100001> 600001"), "Mapped <:pog:9100001> to :pog: on Discord.");
	assert.equal(mappings.emoji.fluxer.get("9100001"), "600001");
	assert.match(await run("$nk map emoji <a:pog2:9100002> 600001"), /already mapped/);
	assert.match(await run("$nk map emoji <:x:9100003> 699999"), /no custom emoji 699999/);
	assert.match(await run("$nk map emoji 🙂 600001"), /Only custom emoji/);
});

test("map role takes plain IDs on both sides", async () => {
	assert.equal(await run("$nk map role 800001 700001"), "Mapped role **Moderators** to Discord role **Mods**.");
	assert.equal(mappings.role.fluxer.get("800001"), "700001");
	assert.match(await run("$nk map role 899999 700002"), /no role 899999 in this server/);
	assert.match(await run("$nk map role 800001"), /Usage.*IDs, not mentions/);
});

test("unmap works out what to remove from the argument", async () => {
	await run("$nk map channel 110000");
	await run("$nk map user <@9001> 500001");
	await run("$nk map emoji <:pog:9100001> 600001");
	await run("$nk map role 800001 700001");

	assert.equal(await run("$nk unmap <@9001>"), "Unlinked <@9001> from Discord user **Alice**.");
	assert.equal(await run("$nk unmap <:pog:9100001>"), "Unmapped <:pog:9100001> from :pog: on Discord.");
	assert.equal(await run("$nk unmap 800001"), "Unmapped role **Moderators** from Discord role **Mods**.");
	assert.equal(await run("$nk unmap <#210000>", { channelId: "299999" }), "Unbridged <#210000> from #general on Discord.");

	assert.deepEqual(db.allLinks(), { channels: [], users: [], emoji: [], roles: [] });
	assert.match(await run("$nk unmap <@9001>"), /Nothing is mapped to 9001/);
});

test("unmap with no argument removes this channel's bridge, unless an import is active", async () => {
	await run("$nk map channel 110000");
	importActive.add("210000");
	assert.match(await run("$nk unmap"), /import is running.*\$nk import cancel/);
	importActive.clear();
	assert.equal(await run("$nk unmap"), "Unbridged this channel from #general on Discord.");
	assert.equal(await run("$nk unmap"), "This channel isn't bridged.");
});

test("unmap accepts an optional kind and Discord-side IDs", async () => {
	await run("$nk map role 800001 700001");
	assert.match(await run("$nk unmap user 800001"), /Nothing is mapped/);
	assert.match(await run("$nk unmap role 700001"), /Unmapped role/);
});

test("mappings apply to the relay immediately", async () => {
	const relay = new Relay({
		config: testConfig({ channels: [], users: [] }),
		db,
		mappings,
		adapters: { discord, fluxer },
		fetch: fakeFetch,
	});
	relay.markReady();

	await relay.onMessage("discord", "110000", async () => bridgeMessage("discord", { channelId: "110000" }));
	assert.equal(fluxer.sent.length, 0);

	await run("$nk map channel 110000");
	await relay.onMessage("discord", "110000", async () => bridgeMessage("discord", { channelId: "110000" }));
	assert.equal(fluxer.sent.length, 1);
	assert.equal(fluxer.sent[0].channelId, "210000");

	await run("$nk unmap");
	await relay.onMessage("discord", "110000", async () => bridgeMessage("discord", { channelId: "110000" }));
	assert.equal(fluxer.sent.length, 1);
});
