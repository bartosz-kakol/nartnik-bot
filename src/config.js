import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";

const SNOWFLAKE = /^\d{5,25}$/;
const MiB = 1024 * 1024;

export class ConfigError extends Error {
	constructor(problems) {
		super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
		this.name = "ConfigError";
		this.problems = problems;
	}
}

/**
 * Load and validate configuration.
 * @param {object} [options]
 * @param {string} [options.configPath] path to config.yaml (default: $NARTNIK_CONFIG or ./config.yaml)
 * @param {string} [options.envPath] path to .env (default: ./.env, skipped when missing)
 * @param {NodeJS.ProcessEnv} [options.env] environment to read secrets from (default: process.env)
 */
export function loadConfig(options = {}) {
	const envPath = options.envPath ?? resolve(".env");
	if (!options.env && existsSync(envPath)) process.loadEnvFile(envPath);
	const env = options.env ?? process.env;

	const configPath = resolve(
		options.configPath ?? env.NARTNIK_CONFIG ?? "config.yaml",
	);
	if (!existsSync(configPath)) {
		throw new ConfigError([
			`${configPath} not found (copy config.example.yaml to config.yaml and fill it in)`,
		]);
	}
	let raw;
	try {
		raw =
			parseYaml(readFileSync(configPath, "utf8"), { intAsBigInt: true }) ?? {};
	} catch (err) {
		throw new ConfigError([`${configPath} is not valid YAML: ${err.message}`]);
	}
	return validateConfig(raw, env, dirname(configPath));
}

/** Validate an already parsed config object plus env. Exported for tests. */
export function validateConfig(raw, env, baseDir = process.cwd()) {
	const problems = [];

	const secret = (name, required = true) => {
		const value = env[name]?.trim();
		if (!value && required) problems.push(`${name} is missing from .env`);
		return value || null;
	};

	const id = (value, where, required = true) => {
		if (value === undefined || value === null || value === "") {
			if (required) problems.push(`${where} is required`);
			return null;
		}
		if (typeof value !== "string") {
			problems.push(
				`${where} must be a quoted string (snowflake IDs are too large for YAML numbers), got ${value}`,
			);
			return null;
		}
		if (!SNOWFLAKE.test(value)) {
			problems.push(`${where} must be a numeric ID, got "${value}"`);
			return null;
		}
		return value;
	};

	const pairs = (key) => {
		const list = raw[key] ?? [];
		if (!Array.isArray(list)) {
			problems.push(`${key} must be a list of { discord, fluxer } pairs`);
			return [];
		}
		const result = [];
		const seenDiscord = new Set();
		const seenFluxer = new Set();
		list.forEach((entry, i) => {
			if (typeof entry !== "object" || entry === null) {
				problems.push(
					`${key}[${i}] must be an object with discord and fluxer keys`,
				);
				return;
			}
			const discord = id(entry.discord, `${key}[${i}].discord`);
			const fluxer = id(entry.fluxer, `${key}[${i}].fluxer`);
			if (!discord || !fluxer) return;
			if (seenDiscord.has(discord))
				problems.push(
					`${key}[${i}].discord ${discord} is listed more than once`,
				);
			if (seenFluxer.has(fluxer))
				problems.push(`${key}[${i}].fluxer ${fluxer} is listed more than once`);
			seenDiscord.add(discord);
			seenFluxer.add(fluxer);
			result.push({ discord, fluxer });
		});
		return result;
	};

	const positiveNumber = (value, where, fallback) => {
		if (value === undefined || value === null) return fallback;
		const n = typeof value === "bigint" ? Number(value) : value;
		if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
			problems.push(`${where} must be a positive number`);
			return fallback;
		}
		return n;
	};

	const discordSection = raw.discord ?? {};
	const fluxerSection = raw.fluxer ?? {};
	const roleIds = fluxerSection.privileged_role_ids ?? [];
	if (!Array.isArray(roleIds))
		problems.push("fluxer.privileged_role_ids must be a list");

	const prefix = raw.command_prefix ?? "!";
	if (typeof prefix !== "string" || prefix.length === 0 || /\s/.test(prefix)) {
		problems.push("command_prefix must be a non-empty string without spaces");
	}

	const logLevel = raw.log_level ?? "info";
	if (!["debug", "info", "warn", "error"].includes(logLevel)) {
		problems.push("log_level must be one of debug, info, warn, error");
	}

	const instance = fluxerSection.instance ?? "https://fluxer.app";
	if (typeof instance !== "string" || !/^https?:\/\//.test(instance)) {
		problems.push("fluxer.instance must be an http(s) URL");
	}

	const limits = raw.limits ?? {};
	const importSection = raw.import ?? {};

	const config = {
		secrets: {
			discordToken: secret("DISCORD_TOKEN"),
			discordClientId: secret("DISCORD_CLIENT_ID", false),
			fluxerToken: secret("FLUXER_TOKEN"),
		},
		discord: {
			guildId: id(discordSection.guild_id, "discord.guild_id"),
		},
		fluxer: {
			guildId: id(fluxerSection.guild_id, "fluxer.guild_id"),
			instance: String(instance).replace(/\/+$/, ""),
			privilegedRoleIds: Array.isArray(roleIds)
				? roleIds
						.map((r, i) => id(r, `fluxer.privileged_role_ids[${i}]`))
						.filter(Boolean)
				: [],
		},
		commandPrefix: prefix,
		databasePath: resolve(baseDir, raw.database_path ?? "./data/nartnik.db"),
		logLevel,
		webhookName:
			typeof raw.webhook_name === "string" && raw.webhook_name.trim()
				? raw.webhook_name.trim()
				: "Nartnik",
		pingLinkedUsers: raw.ping_linked_users ?? true,
		limits: {
			fluxerUploadBytes:
				positiveNumber(
					limits.fluxer_upload_mib,
					"limits.fluxer_upload_mib",
					25,
				) * MiB,
			discordUploadBytes:
				limits.discord_upload_mib == null
					? null // derived from the server's boost tier at runtime
					: positiveNumber(
							limits.discord_upload_mib,
							"limits.discord_upload_mib",
							10,
						) * MiB,
		},
		import: {
			maxMessages: positiveNumber(
				importSection.max_messages,
				"import.max_messages",
				10000,
			),
			confirmTimeoutMs:
				positiveNumber(
					importSection.confirm_timeout_minutes,
					"import.confirm_timeout_minutes",
					10,
				) * 60_000,
		},
		// Only used to seed the database on the first start; after that the database is the source of truth.
		channels: pairs("channels"),
		users: pairs("users"),
		emoji: pairs("emoji"),
		roles: pairs("roles"),
	};

	if (typeof config.pingLinkedUsers !== "boolean")
		problems.push("ping_linked_users must be true or false");

	if (problems.length) throw new ConfigError(problems);

	return config;
}
