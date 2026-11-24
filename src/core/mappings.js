import { pairMaps } from "./transform.js";

export const KINDS = ["channel", "user", "emoji", "role"];

export class Mappings {
	/**
	 * @param {object} source
	 * @param {ReturnType<import('../db.js').openDatabase>} [source.db]  load from and save to this database
	 * @param {{channels?:object[],users?:object[],emoji?:object[],roles?:object[]}} [source.lists]  in-memory only (tests)
	 */
	constructor({ db = null, lists = null } = {}) {
		this.db = db;

		const loaded = db ? db.allLinks() : lists ?? {};

		this.channel = pairMaps(loaded.channels ?? []);
		this.user = pairMaps(loaded.users ?? []);
		this.emoji = pairMaps(loaded.emoji ?? []);
		this.role = pairMaps(loaded.roles ?? []);
	}

	/** The pair of `kind` containing `id` on `platform`, or null. */
	find(kind, platform, id) {
		const other = this[kind][platform].get(id);

		if (other === undefined) {
			return null;
		}

		return platform === "discord"
			? { discord: id, fluxer: other }
			: { discord: other, fluxer: id };
	}

	/** Add a pair. Returns false (and changes nothing) if either side is already mapped for this kind. */
	add(kind, discordId, fluxerId) {
		const maps = this[kind];

		if (maps.discord.has(discordId) || maps.fluxer.has(fluxerId)) {
			return false;
		}

		if (this.db && !this.db.addLink(kind, discordId, fluxerId)) {
			return false;
		}

		maps.discord.set(discordId, fluxerId);
		maps.fluxer.set(fluxerId, discordId);

		return true;
	}

	/** Remove the pair of `kind` containing `id` on `platform`. Returns the removed pair, or null. */
	remove(kind, platform, id) {
		const pair = this.find(kind, platform, id);

		if (!pair) {
			return null;
		}

		this.db?.removeLink(kind, pair[platform]);

		this[kind].discord.delete(pair.discord);
		this[kind].fluxer.delete(pair.fluxer);

		return pair;
	}
}
