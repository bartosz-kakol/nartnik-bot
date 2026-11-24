import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";

const config = {
	channels: [{ discord: "110000", fluxer: "210000" }],
	users: [
		{ discord: "1", fluxer: "9001" },
		{ discord: "2", fluxer: "9002" },
	],
	emoji: [],
};

test("config.yaml mappings are imported once", () => {
	const db = openDatabase(":memory:");
	assert.equal(db.linksSeededFromConfig(), false);
	assert.deepEqual(db.seedLinksFromConfig(config), { channel: 1, user: 2, emoji: 0, role: 0 });
	assert.equal(db.linksSeededFromConfig(), true);

	// Later starts ignore config.yaml, even when it lists new pairs or a removed pair is still there.
	db.removeLink("user", "9002");
	const changed = { ...config, channels: [...config.channels, { discord: "120000", fluxer: "220000" }] };
	assert.equal(db.seedLinksFromConfig(changed), null);
	assert.deepEqual(db.allLinks(), {
		channels: [{ discord: "110000", fluxer: "210000" }],
		users: [{ discord: "1", fluxer: "9001" }],
		emoji: [],
		roles: [],
	});
});

test("the flag is set even when config.yaml lists nothing", () => {
	const db = openDatabase(":memory:");
	assert.deepEqual(db.seedLinksFromConfig({}), { channel: 0, user: 0, emoji: 0, role: 0 });
	assert.equal(db.seedLinksFromConfig(config), null);
	assert.deepEqual(db.links("channel"), []);
});

test("addLink refuses an ID that is already linked", () => {
	const db = openDatabase(":memory:");
	assert.equal(db.addLink("channel", "110000", "210000"), true);
	assert.equal(db.addLink("channel", "110000", "299999"), false);
	assert.equal(db.addLink("channel", "199999", "210000"), false);
	assert.equal(db.addLink("user", "110000", "210000"), true); // kinds are separate
	assert.throws(() => db.addLink("sticker", "1", "2"), /Unknown link kind/);
	assert.equal(db.removeLink("channel", "110000"), true);
	assert.equal(db.removeLink("channel", "110000"), false);
});
