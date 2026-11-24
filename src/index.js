import { loadConfig, ConfigError } from "./config.js";
import { openDatabase } from "./db.js";
import { createLogger, setLogLevel } from "./log.js";
import { Relay, describe } from "./core/relay.js";
import { Importer } from "./core/import.js";
import { Mapper } from "./core/mapper.js";
import { Mappings } from "./core/mappings.js";
import { DiscordAdapter } from "./platforms/discord.js";
import { FluxerAdapter } from "./platforms/fluxer.js";

const log = createLogger("main");

async function main() {
	/** @type {ReturnType<loadConfig>} */
	let config;

	try {
		config = loadConfig();
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(err.message);
			process.exit(1);
		}

		throw err;
	}

	setLogLevel(config.logLevel);

	const db = openDatabase(config.databasePath);

	// Channel, user, emoji and role mappings live in the database. config.yaml's lists only seed it on the first
	// start. after that they are changed with the map/unmap commands.
	const seeded = db.seedLinksFromConfig(config);
	if (seeded) {
		log.info(
			`imported mappings from config.yaml: ${seeded.channel} channel(s), ${seeded.user} user(s), ${seeded.emoji} emoji, ${seeded.role} role(s)`,
		);
	} else if (
		config.channels.length || config.users.length || config.emoji.length || config.roles.length
	) {
		log.info(
			"config.yaml still lists mappings; they were imported earlier and are now ignored (use the map/unmap commands)",
		);
	}
	const mappings = new Mappings({ db });
	const discord = new DiscordAdapter({ config, db, mappings });
	const fluxer = new FluxerAdapter({ config, db, mappings });
	const relay = new Relay({ config, db, mappings, adapters: { discord, fluxer } });
	const importer = new Importer({ config, db, relay, discord, fluxer });
	const mapper = new Mapper({ config, mappings, importer, discord, fluxer });

	let shuttingDown = false;

	const shutdown = async (signal) => {
		if (shuttingDown) return;

		shuttingDown = true;

		log.info(`${signal} received, shutting down`);
		const force = setTimeout(() => process.exit(1), 10_000);
		force.unref();
		await Promise.allSettled([discord.stop(), fluxer.stop()]);

		db.close();

		process.exit(0);
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("unhandledRejection", (err) =>
		log.error("unhandled rejection:", describe(err)),
	);

	const channelCount = mappings.channel.discord.size;
	if (channelCount === 0) {
		log.warn("no bridged channels yet: run the map channel command in a Fluxer channel");
	} else {
		log.info(`bridging ${channelCount} channel pair(s)`);
	}

	await Promise.all([
		discord.start({
			onMessage: (channelId, prepare) =>
				relay.onMessage("discord", channelId, prepare),

			onEdit: (channelId, messageId, prepare) =>
				relay.onEdit("discord", channelId, messageId, prepare),

			onDelete: (channelId, messageId) =>
				relay.onDelete("discord", channelId, messageId),
		}),

		fluxer.start({
			onMessage: (channelId, prepare) =>
				relay.onMessage("fluxer", channelId, prepare),

			onEdit: (channelId, messageId, prepare) =>
				relay.onEdit("fluxer", channelId, messageId, prepare),

			onDelete: (channelId, messageId) =>
				relay.onDelete("fluxer", channelId, messageId),

			onCommand: (msg) => importer.handleCommand(msg) || mapper.handleCommand(msg),

			onReaction: (reaction) => importer.handleReaction(reaction),
		}),
	]);

	await relay.prepareWebhooks();
	relay.markReady();
	await importer.resume();
	
	log.info("ready");
}

main().catch((err) => {
	log.error("fatal:", err);
	process.exit(1);
});
