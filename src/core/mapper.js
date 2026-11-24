// Mapping commands, run on Fluxer by members holding a privileged role. Changes apply at once and are saved
// in the database.
//
//   map channel <Discord channel ID>               bridge the current Fluxer channel with a Discord channel
//   map user <@Fluxer user> <Discord user ID>      link a Fluxer account with a Discord account
//   map emoji <Fluxer emoji> <Discord emoji ID>    map a custom emoji
//   map role <Fluxer role ID> <Discord role ID>    map a role (IDs, not mentions, so nobody gets pinged)
//   unmap [<#channel> | <@user> | <emoji> | <role ID>]   remove a mapping; with no argument, this channel's bridge

import { createLogger } from "../log.js";
import { describe } from "./relay.js";
import { escapeMarkdown } from "./transform.js";
import { KINDS } from "./mappings.js";
import { commandText, isPrivileged, parseCommand } from "./commands.js";

const log = createLogger("mapper");

const ID = /^\d{5,25}$/;
const MENTION = {
	channel: /^<#(\d+)>$/,
	user: /^<@!?(\d+)>$/,
	role: /^<@&(\d+)>$/,
	emoji: /^<a?:\w+:(\d+)>$/,
};

/** An argument written as a raw ID or as a mention/literal of `kind`; null if it is neither. */
function idOf(arg, kind) {
	if (!arg) return null;
	if (ID.test(arg)) return arg;
	return MENTION[kind].exec(arg)?.[1] ?? null;
}

/** The kind and ID of a mention or literal (#channel, @user, @role, custom emoji), or null. */
function detect(arg) {
	for (const kind of KINDS) {
		const id = MENTION[kind].exec(arg)?.[1];
		if (id) return { kind, id };
	}
	return null;
}

const bold = (name) => `**${escapeMarkdown(name)}**`;

export class Mapper {
	/**
	 * @param {object} deps
	 * @param {object} deps.config
	 * @param {import('./mappings.js').Mappings} deps.mappings
	 * @param {import('./import.js').Importer} deps.importer
	 * @param {import('../platforms/discord.js').DiscordAdapter} deps.discord
	 * @param {import('../platforms/fluxer.js').FluxerAdapter} deps.fluxer
	 */
	constructor({ config, mappings, importer, discord, fluxer }) {
		this.config = config;
		this.mappings = mappings;
		this.importer = importer;
		this.discord = discord;
		this.fluxer = fluxer;
		this.cmd = (name) => commandText(config.commandPrefix, name);
	}

	/** Called for every Fluxer message starting with the prefix. Returns true if it was a map/unmap command. */
	handleCommand(msg) {
		const command = parseCommand(msg.content, this.config.commandPrefix);
		if (command?.name !== "map" && command?.name !== "unmap") return false;
		this.run(msg, command.name, command.args).catch(async (err) => {
			log.error(`${command.name} command failed:`, describe(err));
			await this.say(msg, `That didn't work: ${err.message}`).catch(() => {});
		});
		return true;
	}

	/** Run a command and post the reply. Exposed for tests: resolves with the reply text. */
	async run(msg, name, args) {
		const reply = (await isPrivileged(this.fluxer, this.config, msg.author.id))
			? name === "map"
				? await this.map(msg, args)
				: await this.unmap(msg, args)
			: "You are not allowed to change mappings.";
		await this.say(msg, reply);
		return reply;
	}

	usage() {
		return [
			"Usage:",
			`\`${this.cmd("map channel")} <Discord channel ID>\` (in the Fluxer channel to bridge)`,
			`\`${this.cmd("map user")} @user <Discord user ID>\``,
			`\`${this.cmd("map emoji")} :emoji: <Discord emoji ID>\``,
			`\`${this.cmd("map role")} <Fluxer role ID> <Discord role ID>\``,
			`\`${this.cmd("unmap")} [#channel | @user | :emoji: | role ID]\` (no argument: this channel)`,
		].join("\n");
	}

	// ---------------------------------------------------------------- map

	async map(msg, [kind, ...args]) {
		switch (kind?.toLowerCase()) {
			case "channel":
				return this.mapChannel(msg.channelId, args[0]);
			case "user":
				return this.mapUser(args[0], args[1]);
			case "emoji":
				return this.mapEmoji(args[0], args[1]);
			case "role":
				return this.mapRole(args[0], args[1]);
			default:
				return this.usage();
		}
	}

	async mapChannel(fluxerId, arg) {
		const discordId = idOf(arg, "channel");
		if (!discordId) return `Usage: \`${this.cmd("map channel")} <Discord channel ID>\``;

		const current = this.mappings.find("channel", "fluxer", fluxerId);
		if (current) {
			return `This channel is already bridged with ${await this.discordChannelLabel(current.discord)}. Run \`${this.cmd("unmap")}\` here first.`;
		}
		const taken = this.mappings.find("channel", "discord", discordId);
		if (taken) return `That Discord channel is already bridged with <#${taken.fluxer}>.`;

		const channel = await this.discord.lookupChannel(discordId);
		if (!channel) return `There is no channel ${discordId} in the Discord server.`;
		if (!channel.webhooks) {
			return `#${escapeMarkdown(channel.name)} on Discord can't be bridged: pick a text channel.`;
		}

		try {
			await this.discord.ensureWebhook(discordId);
			await this.fluxer.ensureWebhook(fluxerId);
		} catch (err) {
			log.warn(`webhook setup for ${discordId} <-> ${fluxerId} failed:`, describe(err));
			return `Couldn't set up webhooks (${err.message}). Check that the bot can manage webhooks in both channels.`;
		}

		if (!this.mappings.add("channel", discordId, fluxerId)) {
			return "This channel or that Discord channel was mapped in the meantime; nothing changed.";
		}
		log.info(`mapped channel discord:${discordId} <-> fluxer:${fluxerId}`);
		return `Bridged this channel with #${escapeMarkdown(channel.name)} on Discord.`;
	}

	async mapUser(userArg, discordArg) {
		const fluxerId = idOf(userArg, "user");
		const discordId = idOf(discordArg, "user");
		if (!fluxerId || !discordId) return `Usage: \`${this.cmd("map user")} @user <Discord user ID>\``;

		const current = this.mappings.find("user", "fluxer", fluxerId);
		if (current) {
			return `<@${fluxerId}> is already linked with Discord user ${await this.discordUserLabel(current.discord)}.`;
		}
		const taken = this.mappings.find("user", "discord", discordId);
		if (taken) return `That Discord user is already linked with <@${taken.fluxer}>.`;

		if (!(await this.fluxer.isMember(fluxerId))) return `<@${fluxerId}> isn't a member of this server.`;
		const name = await this.discord.lookupUser(discordId);
		if (!name) return `There is no Discord user with ID ${discordId}.`;

		if (!this.mappings.add("user", discordId, fluxerId)) return "One of them was linked in the meantime; nothing changed.";
		log.info(`mapped user discord:${discordId} <-> fluxer:${fluxerId}`);
		return `Linked <@${fluxerId}> with Discord user ${bold(name)}.`;
	}

	async mapEmoji(emojiArg, discordArg) {
		const fluxerId = idOf(emojiArg, "emoji");
		const discordId = idOf(discordArg, "emoji");
		if (emojiArg && !fluxerId && !ID.test(emojiArg) && !emojiArg.startsWith("<")) {
			return "Only custom emoji can be mapped. Standard emoji already look the same on both sides.";
		}
		if (!fluxerId || !discordId) return `Usage: \`${this.cmd("map emoji")} :emoji: <Discord emoji ID>\``;
		const shown = MENTION.emoji.test(emojiArg) ? emojiArg : `emoji ${fluxerId}`;

		const current = this.mappings.find("emoji", "fluxer", fluxerId);
		if (current) {
			return `${shown} is already mapped to ${await this.discordEmojiLabel(current.discord)}.`;
		}
		if (this.mappings.find("emoji", "discord", discordId)) {
			return `Discord emoji ${discordId} is already mapped to another emoji.`;
		}

		const name = await this.discord.lookupEmoji(discordId);
		if (!name) return `There is no custom emoji ${discordId} in the Discord server.`;

		if (!this.mappings.add("emoji", discordId, fluxerId)) return "One of them was mapped in the meantime; nothing changed.";
		log.info(`mapped emoji discord:${discordId} <-> fluxer:${fluxerId}`);
		return `Mapped ${shown} to :${escapeMarkdown(name)}: on Discord.`;
	}

	async mapRole(fluxerArg, discordArg) {
		const fluxerId = idOf(fluxerArg, "role");
		const discordId = idOf(discordArg, "role");
		if (!fluxerId || !discordId) {
			return `Usage: \`${this.cmd("map role")} <Fluxer role ID> <Discord role ID>\` (IDs, not mentions)`;
		}

		const current = this.mappings.find("role", "fluxer", fluxerId);
		if (current) {
			const name = await this.discord.lookupRole(current.discord);
			return `That Fluxer role is already mapped to Discord role ${name ? bold(name) : current.discord}.`;
		}
		if (this.mappings.find("role", "discord", discordId)) {
			return `Discord role ${discordId} is already mapped to another role.`;
		}

		const fluxerName = await this.fluxer.lookupRole(fluxerId);
		if (!fluxerName) return `There is no role ${fluxerId} in this server.`;
		const discordName = await this.discord.lookupRole(discordId);
		if (!discordName) return `There is no role ${discordId} in the Discord server.`;

		if (!this.mappings.add("role", discordId, fluxerId)) return "One of them was mapped in the meantime; nothing changed.";
		log.info(`mapped role discord:${discordId} <-> fluxer:${fluxerId}`);
		return `Mapped role ${bold(fluxerName)} to Discord role ${bold(discordName)}.`;
	}

	// ---------------------------------------------------------------- unmap

	async unmap(msg, args) {
		// An optional kind word first ("unmap role 123") narrows the search; it is never required.
		let kind = KINDS.includes(args[0]?.toLowerCase()) ? args.shift().toLowerCase() : null;
		const arg = args[0];
		let id;

		if (!arg) {
			if (kind && kind !== "channel") return this.usage();
			kind = "channel";
			id = msg.channelId;
		} else {
			const found = detect(arg);
			if (found) {
				if (kind && kind !== found.kind) return this.usage();
				({ kind, id } = found);
			} else if (ID.test(arg)) {
				id = arg;
			} else {
				return this.usage();
			}
		}

		// Look on the Fluxer side first, then the Discord side, in the given kind or all of them.
		let match = null;
		for (const platform of ["fluxer", "discord"]) {
			for (const k of kind ? [kind] : KINDS) {
				const pair = this.mappings.find(k, platform, id);
				if (pair) {
					match = { kind: k, pair };
					break;
				}
			}
			if (match) break;
		}
		if (!match) {
			return id === msg.channelId && kind === "channel"
				? "This channel isn't bridged."
				: `Nothing is mapped to ${id}.`;
		}

		const { pair } = match;
		if (match.kind === "channel" && this.importer?.activeIn(pair.fluxer)) {
			return `An import is running or waiting for confirmation in <#${pair.fluxer}>. Run \`${this.cmd("import cancel")}\` there first.`;
		}

		this.mappings.remove(match.kind, "fluxer", pair.fluxer);
		log.info(`unmapped ${match.kind} discord:${pair.discord} <-> fluxer:${pair.fluxer}`);

		switch (match.kind) {
			case "channel": {
				const where = pair.fluxer === msg.channelId ? "this channel" : `<#${pair.fluxer}>`;
				return `Unbridged ${where} from ${await this.discordChannelLabel(pair.discord)}.`;
			}
			case "user":
				return `Unlinked <@${pair.fluxer}> from Discord user ${await this.discordUserLabel(pair.discord)}.`;
			case "emoji":
				return `Unmapped ${MENTION.emoji.test(arg ?? "") ? arg : `emoji ${pair.fluxer}`} from ${await this.discordEmojiLabel(pair.discord)}.`;
			case "role": {
				const fluxerName = await this.fluxer.lookupRole(pair.fluxer);
				const discordName = await this.discord.lookupRole(pair.discord);
				return `Unmapped role ${fluxerName ? bold(fluxerName) : pair.fluxer} from Discord role ${discordName ? bold(discordName) : pair.discord}.`;
			}
		}
	}

	// ---------------------------------------------------------------- helpers

	async discordChannelLabel(id) {
		const channel = await this.discord.lookupChannel(id).catch(() => null);
		return channel ? `#${escapeMarkdown(channel.name)} on Discord` : `Discord channel ${id}`;
	}

	async discordUserLabel(id) {
		const name = await this.discord.lookupUser(id).catch(() => null);
		return name ? bold(name) : id;
	}

	async discordEmojiLabel(id) {
		const name = await this.discord.lookupEmoji(id).catch(() => null);
		return name ? `:${escapeMarkdown(name)}: on Discord` : `Discord emoji ${id}`;
	}

	say(msg, text) {
		return this.fluxer.post(msg.channelId, text, { replyTo: msg.id });
	}
}
