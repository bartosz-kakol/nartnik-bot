import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../src/config.js";

const env = { DISCORD_TOKEN: "d", FLUXER_TOKEN: "f" };

function write(yaml) {
	const dir = mkdtempSync(join(tmpdir(), "nartnik-"));
	const path = join(dir, "config.yaml");
	writeFileSync(path, yaml);
	return { dir, path };
}

const valid = `
discord:
  guild_id: "100000"
fluxer:
  guild_id: "200000"
  privileged_role_ids: ["300000"]
channels:
  - discord: "110000"
    fluxer: "210000"
`;

test("loads a valid config with defaults", () => {
	const { dir, path } = write(valid);
	const c = loadConfig({ configPath: path, env });
	assert.equal(c.discord.guildId, "100000");
	assert.deepEqual(c.fluxer.privilegedRoleIds, ["300000"]);
	assert.equal(c.commandPrefix, "!");
	assert.equal(c.databasePath, join(dir, "data/nartnik.db"));
	assert.equal(c.fluxer.instance, "https://fluxer.app");
	assert.equal(c.limits.fluxerUploadBytes, 25 * 1024 * 1024);
	assert.equal(c.limits.discordUploadBytes, null);
	assert.deepEqual(c.channels, [{ discord: "110000", fluxer: "210000" }]);
	assert.deepEqual(c.users, []);
});

test("rejects unquoted IDs, missing secrets and duplicates", () => {
	const { path } = write(`
discord:
  guild_id: 123456789012345678
fluxer:
  guild_id: "200000"
channels:
  - discord: "110000"
    fluxer: "210000"
  - discord: "110000"
    fluxer: "220000"
`);
	assert.throws(
		() => loadConfig({ configPath: path, env: {} }),
		(err) => {
			assert.ok(err instanceof ConfigError);
			const text = err.problems.join("\n");
			assert.match(text, /DISCORD_TOKEN/);
			assert.match(text, /FLUXER_TOKEN/);
			assert.match(text, /discord\.guild_id must be a quoted string/);
			assert.match(text, /listed more than once/);
			return true;
		},
	);
});

test("channel, user and emoji lists are optional", () => {
	const { path } = write(
		'discord: { guild_id: "100000" }\nfluxer: { guild_id: "200000" }\n',
	);
	const c = loadConfig({ configPath: path, env });
	assert.deepEqual([c.channels, c.users, c.emoji], [[], [], []]);
});

test("config.example.yaml is valid", () => {
	const example = readFileSync(
		new URL("../config.example.yaml", import.meta.url),
		"utf8",
	);
	const { path } = write(example);
	assert.doesNotThrow(() => loadConfig({ configPath: path, env }));
});
