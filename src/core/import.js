// History import: a Fluxer-only command that copies the newest N Discord messages into the paired Fluxer channel.
//
//   !import <max>     fetch up to <max> newest messages and ask for confirmation
//   !import cancel    stop the running import in this channel
//
// Only members holding a role from fluxer.privileged_role_ids may use it, and only the member who started an import
// can confirm it, by reacting ✅ to the summary.

import { createLogger } from "../log.js";
import { describe } from "./relay.js";
import { commandText, isPrivileged, parseCommand } from "./commands.js";

const log = createLogger("import");
const CONFIRM_EMOJI = "✅";

export class Importer {
	/**
	 * @param {object} deps
	 * @param {object} deps.config
	 * @param {object} deps.db
	 * @param {import('./relay.js').Relay} deps.relay
	 * @param {import('../platforms/discord.js').DiscordAdapter} deps.discord
	 * @param {import('../platforms/fluxer.js').FluxerAdapter} deps.fluxer
	 */
	constructor({ config, db, relay, discord, fluxer }) {
		this.config = config;
		this.db = db;
		this.relay = relay;
		this.discord = discord;
		this.fluxer = fluxer;
		this.pending = new Map(); // summary message ID -> pending import
		this.cancelled = new Set(); // import IDs asked to stop
		this.busy = new Set(); // Fluxer channels where a command is being handled
		this.commandName = commandText(config.commandPrefix, "import");
	}

	/**
	 * Called for every Fluxer message starting with the prefix. Returns true if it was our command.
	 * The space after the prefix is optional: "!import 5" and "! import 5" (or "$nk import 5") both work.
	 */
	handleCommand(msg) {
		const command = parseCommand(msg.content, this.config.commandPrefix);
		if (command?.name !== "import") return false;
		const { args } = command;
		if (this.busy.has(msg.channelId)) return true;
		this.busy.add(msg.channelId);
		this.run(msg, args)
			.catch(async (err) => {
				log.error("import command failed:", describe(err));
				await this.say(msg, `Import failed: ${err.message}`).catch(() => {});
			})
			.finally(() => this.busy.delete(msg.channelId));
		return true;
	}

	async run(msg, args) {
		const channelId = msg.channelId;
		const userId = msg.author.id;

		if (!(await this.isPrivileged(userId))) {
			log.info(`refused import command from ${userId}: not privileged`);
			await this.say(msg, "You are not allowed to run imports.");
			return;
		}

		const discordChannelId = this.relay.channels.fluxer.get(channelId);
		if (!discordChannelId) {
			await this.say(msg, "This channel is not bridged to a Discord channel.");
			return;
		}

		const running = this.db.runningImportForChannel(channelId);
		if (args[0]?.toLowerCase() === "cancel") {
			if (!running) {
				await this.say(msg, "There is no running import in this channel.");
				return;
			}
			this.cancelled.add(running.id);
			this.db.finishImport(running.id, "cancelled");
			await this.say(
				msg,
				`Import cancelled after ${running.done} of ${running.total} messages.`,
			);
			return;
		}

		const max = Number(args[0]);
		if (!Number.isInteger(max) || max < 1) {
			await this.say(
				msg,
				`Usage: \`${this.commandName} <max messages>\` or \`${this.commandName} cancel\``,
			);
			return;
		}
		if (max > this.config.import.maxMessages) {
			await this.say(
				msg,
				`The most I can import at once is ${this.config.import.maxMessages} messages.`,
			);
			return;
		}
		if (running) {
			await this.say(
				msg,
				`An import is already running here (${running.done}/${running.total}).`,
			);
			return;
		}
		for (const p of this.pending.values()) {
			if (p.fluxerChannelId === channelId) {
				await this.say(
					msg,
					"An import is already waiting for confirmation in this channel.",
				);
				return;
			}
		}

		const fetched = await this.discord.fetchNewest(discordChannelId, max);
		const messages = fetched.filter(
			(m) => this.discord.isRelayable(m) && !this.db.findPair("discord", m.id),
		);
		const skipped = fetched.length - messages.length;
		const channelName = await this.discord.channelName(discordChannelId);

		if (messages.length === 0) {
			await this.say(
				msg,
				`Nothing to import from Discord #${channelName}` +
					(skipped
						? ` (${skipped} message(s) are already bridged or not importable).`
						: "."),
			);
			return;
		}

		const minutes = Math.ceil(messages.length / 60);
		const lines = [
			`**History import from Discord #${channelName}**`,
			`${messages.length} message(s) to import, from ${formatDate(messages[0].createdAt)} ` +
				`to ${formatDate(messages.at(-1).createdAt)}.`,
			skipped
				? `${skipped} message(s) skipped (already bridged, bridged from Fluxer, or system messages).`
				: null,
			`This takes about ${minutes} minute(s). New Discord messages in this channel wait until it is done.`,
			`To start, **${msg.author.globalName ?? msg.author.username}** reacts with ${CONFIRM_EMOJI} ` +
				`within ${Math.round(this.config.import.confirmTimeoutMs / 60_000)} minutes.`,
		].filter(Boolean);
		const summaryId = await this.fluxer.post(channelId, lines.join("\n"), {
			replyTo: msg.id,
		});
		await this.fluxer
			.react(channelId, summaryId, CONFIRM_EMOJI)
			.catch(() => {});

		const timer = setTimeout(() => {
			if (this.pending.delete(summaryId)) {
				this.fluxer
					.post(channelId, "Import not confirmed in time; cancelled.", {
						replyTo: summaryId,
					})
					.catch(() => {});
			}
		}, this.config.import.confirmTimeoutMs);
		timer.unref();

		this.pending.set(summaryId, {
			userId,
			fluxerChannelId: channelId,
			discordChannelId,
			messages,
			timer,
		});
		log.info(
			`import of ${messages.length} message(s) into ${channelId} awaiting confirmation from ${userId}`,
		);
	}

	/** Called for every Fluxer reaction. */
	handleReaction({ messageId, userId, emoji }) {
		const pending = this.pending.get(messageId);
		if (!pending || emoji !== CONFIRM_EMOJI || userId !== pending.userId)
			return;
		this.pending.delete(messageId);
		clearTimeout(pending.timer);

		const { messages, fluxerChannelId, discordChannelId } = pending;
		const importId = this.db.createImport({
			fluxerChannelId,
			discordChannelId,
			requestedBy: userId,
			total: messages.length,
			oldestDiscordId: messages[0].id,
			newestDiscordId: messages.at(-1).id,
		});
		log.info(
			`import ${importId} confirmed: ${messages.length} message(s) into ${fluxerChannelId}`,
		);
		this.fluxer
			.post(fluxerChannelId, `Import started: ${messages.length} message(s).`, {
				replyTo: messageId,
			})
			.catch(() => {});
		this.enqueue(importId, fluxerChannelId, messages);
	}

	/** Put every message in the channel queue, then a final job that reports the result. */
	enqueue(importId, fluxerChannelId, messages) {
		let imported = 0;
		let failed = 0;
		for (const raw of messages) {
			this.relay.enqueue("fluxer", fluxerChannelId, async () => {
				if (this.cancelled.has(importId)) return;
				try {
					if (!this.db.findPair("discord", raw.id)) {
						await this.relay.relayNew(await this.discord.normalize(raw));
					}
					imported++;
				} catch (err) {
					failed++;
					log.warn(
						`import ${importId}: message ${raw.id} failed:`,
						describe(err),
					);
				}
				this.db.progressImport(importId, raw.id);
			});
		}
		this.relay.enqueue("fluxer", fluxerChannelId, async () => {
			if (this.cancelled.delete(importId)) return;
			this.db.finishImport(importId, "finished");
			log.info(
				`import ${importId} finished: ${imported} imported, ${failed} failed`,
			);
			await this.fluxer
				.post(
					fluxerChannelId,
					`Import finished: ${imported} message(s) imported${failed ? `, ${failed} failed` : ""}.`,
				)
				.catch(() => {});
		});
	}

	/** Continue imports that were running when the bot stopped. Already imported messages are skipped. */
	async resume() {
		for (const imp of this.db.runningImports()) {
			try {
				const fetched = await this.discord.fetchRange(
					imp.discordChannelId,
					imp.oldestDiscordId,
					imp.newestDiscordId,
				);
				const remaining = fetched.filter(
					(m) =>
						this.discord.isRelayable(m) && !this.db.findPair("discord", m.id),
				);
				log.info(
					`resuming import ${imp.id}: ${remaining.length} message(s) left`,
				);
				this.enqueue(imp.id, imp.fluxerChannelId, remaining);
			} catch (err) {
				log.error(`cannot resume import ${imp.id}:`, describe(err));
				this.db.finishImport(imp.id, "failed");
			}
		}
	}

	isPrivileged(userId) {
		return isPrivileged(this.fluxer, this.config, userId);
	}

	/** Whether an import is running or waiting for confirmation in a Fluxer channel. */
	activeIn(channelId) {
		if (this.db.runningImportForChannel(channelId)) return true;
		for (const p of this.pending.values()) {
			if (p.fluxerChannelId === channelId) return true;
		}
		return false;
	}

	say(msg, text) {
		return this.fluxer.post(msg.channelId, text, { replyTo: msg.id });
	}
}

function formatDate(date) {
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
