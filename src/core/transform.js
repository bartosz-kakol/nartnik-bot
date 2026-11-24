// Platform-neutral content transforms: mentions, emoji, markdown, reply quotes, attachment limits.
// Everything here is pure (no network, no clients) so it can be unit tested.
//
// Both platforms share Discord's message syntax for mentions and custom emoji:
//   <@id> <@!id>   user          <@&id>   role          <#id>   channel
//   <:name:id>     custom emoji  <a:name:id>  animated custom emoji

export const MAX_CONTENT_LENGTH = 2000;
export const MAX_ATTACHMENTS = 10;
const SNIPPET_LENGTH = 100;

const TOKEN =
	/<(@!?|@&|#)(\d+)>|<(a?):(\w{1,64}):(\d+)>|<\/([\w -]{1,100}):\d+>/g;
const SOLO_EMOJI = /^<(a?):(\w{1,64}):(\d+)>$/;
// Fenced code blocks and inline code: mentions and emoji inside them are shown literally, so leave them alone.
const CODE = /(```[\s\S]*?```|`[^`\n]+`)/;

/**
 * Build bidirectional lookup tables from config pairs.
 * @param {{discord:string,fluxer:string}[]} pairs
 */
export function pairMaps(pairs) {
	return {
		discord: new Map(pairs.map((p) => [p.discord, p.fluxer])), // discord id -> fluxer id
		fluxer: new Map(pairs.map((p) => [p.fluxer, p.discord])), // fluxer id -> discord id
	};
}

/**
 * If the message is exactly one custom emoji that has no mapping, return it so it can be sent as an image.
 * @returns {{id:string,name:string,animated:boolean}|null}
 */
export function soloUnmappedEmoji(content, from, emojiMap) {
	const match = SOLO_EMOJI.exec((content ?? "").trim());
	if (!match) return null;
	const [, a, name, id] = match;
	if (emojiMap[from].has(id)) return null;
	return { id, name, animated: a === "a" };
}

/**
 * Convert message content written on `from` so it reads correctly on the other platform.
 *
 * @param {string} content
 * @param {object} ctx
 * @param {'discord'|'fluxer'} ctx.from
 * @param {{discord:Map,fluxer:Map}} ctx.users     linked accounts (pairMaps)
 * @param {{discord:Map,fluxer:Map}} ctx.channels  bridged channels (pairMaps)
 * @param {{discord:Map,fluxer:Map}} ctx.emoji     mapped custom emoji (pairMaps)
 * @param {{discord:Map,fluxer:Map}} [ctx.roles]   mapped roles (pairMaps); unmapped roles become @name
 * @param {{users?:Map,roles?:Map,channels?:Map}} [ctx.names] display names for IDs seen in the message
 * @param {boolean} [ctx.linkUsers=true] false renders every user mention as plain text
 * @returns {{content:string, mentionedUserIds:string[]}} mentionedUserIds are target-platform IDs
 */
export function transformContent(content, ctx) {
	const { from, users, channels, emoji, roles, names = {}, linkUsers = true } = ctx;
	const mentioned = new Set();

	const replaceToken = (match, kind, id, a, emojiName, emojiId, command) => {
		if (command !== undefined) return `/${command}`;
		if (emojiId !== undefined) {
			const target = emoji[from].get(emojiId);
			return target ? `<${a}:${emojiName}:${target}>` : `:${emojiName}:`;
		}
		if (kind === "@" || kind === "@!") {
			const target = linkUsers ? users[from].get(id) : undefined;
			if (target) {
				mentioned.add(target);
				return `<@${target}>`;
			}
			return `@${names.users?.get(id) ?? "unknown-user"}`;
		}
		if (kind === "@&") {
			// Rendered as a real role mention, but never pings: allowed_mentions never lists roles.
			const target = roles?.[from].get(id);
			return target ? `<@&${target}>` : `@${names.roles?.get(id) ?? "unknown-role"}`;
		}
		// channel
		const target = channels[from].get(id);
		return target
			? `<#${target}>`
			: `#${names.channels?.get(id) ?? "unknown-channel"}`;
	};

	const out = (content ?? "")
		.split(CODE)
		.map((part, i) => (i % 2 === 1 ? part : part.replace(TOKEN, replaceToken)))
		.join("");

	return { content: out, mentionedUserIds: [...mentioned] };
}

/** Collapse a message into a single short line for reply quotes. */
export function snippet(text, max = SNIPPET_LENGTH) {
	const flat = (text ?? "")
		.replace(/```[\s\S]*?```/g, "[code]")
		.replace(/^\s*(>+|-#)\s?/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Build the quote line shown above a relayed reply when a real reply is not possible.
 * @param {{authorName:string, text:string, jumpUrl?:string|null}} ref
 */
export function replyQuoteLine({ authorName, text, jumpUrl }) {
	const body = text ? `: ${text}` : "";
	const link = jumpUrl ? ` [jump](<${jumpUrl}>)` : "";
	return `> ↪ **${escapeMarkdown(authorName)}**${body}${link}`;
}

export function escapeMarkdown(text) {
	return String(text).replace(/([\\*_~`|>[\]()#-])/g, "\\$1");
}

/** Clip content to the platform limit, keeping the end marker visible. */
export function clip(content, max = MAX_CONTENT_LENGTH) {
	if (content.length <= max) return content;
	return `${content.slice(0, max - 1)}…`;
}

/**
 * Webhook usernames: 1-80 characters. Discord also rejects names containing "discord" or "clyde",
 * so break those words with a zero-width space.
 */
export function webhookUsername(name, target) {
	let result = (name ?? "").replace(/\s+/g, " ").trim() || "Unknown";
	if (target === "discord") {
		result = result
			.replace(/(disc)(ord)/gi, "$1​$2")
			.replace(/(cly)(de)/gi, "$1​$2");
	}
	return result.length > 80 ? result.slice(0, 80) : result;
}

/**
 * Decide which attachments are uploaded and which become links, given the target's size limit.
 * @param {{name:string,size:number,url:string}[]} attachments
 * @param {number} maxBytes total upload budget per message
 * @returns {{upload: object[], link: object[]}}
 */
export function planAttachments(attachments, maxBytes) {
	const upload = [];
	const link = [];
	let used = 0;
	for (const att of attachments) {
		const size = att.size ?? Infinity;
		if (upload.length < MAX_ATTACHMENTS && used + size <= maxBytes) {
			upload.push(att);
			used += size;
		} else {
			link.push(att);
		}
	}
	return { upload, link };
}

/**
 * Normalise an embed to the snake_case wire format both APIs accept, keeping only sendable fields.
 * Returns null for embeds the target platform generates on its own (link previews, images, videos).
 */
export function toWireEmbed(embed) {
	if (!embed || (embed.type && embed.type !== "rich")) return null;
	
	const media = (m) => (m?.url ? { url: m.url } : undefined);

	const wire = {
		title: embed.title ?? undefined,
		description: embed.description ?? undefined,
		url: embed.url ?? undefined,
		color: embed.color ?? undefined,
		timestamp: embed.timestamp
			? new Date(embed.timestamp).toISOString()
			: undefined,
		author: embed.author?.name
			? {
					name: embed.author.name,
					url: embed.author.url ?? undefined,
					icon_url: embed.author.icon_url ?? embed.author.iconUrl ?? undefined,
				}
			: undefined,
		footer: embed.footer?.text
			? {
					text: embed.footer.text,
					icon_url: embed.footer.icon_url ?? embed.footer.iconUrl ?? undefined,
				}
			: undefined,
		image: media(embed.image),
		thumbnail: media(embed.thumbnail),
		fields: embed.fields?.length
			? embed.fields.map((f) => ({
					name: f.name,
					value: f.value,
					inline: Boolean(f.inline),
				}))
			: undefined,
	};

	compact(wire);

	return Object.keys(wire).length ? wire : null;
}

/** Remove undefined and null values, recursing into plain objects. */
function compact(obj) {
	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === null) delete obj[key];
		else if (typeof value === "object" && !Array.isArray(value)) compact(value);
	}

	return obj;
}
