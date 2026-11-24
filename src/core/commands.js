// Helpers shared by the Fluxer commands (import, map, unmap).

/**
 * Split a message into command name and arguments, or return null if it doesn't start with the prefix.
 * The space after the prefix is optional: "!import 5", "! import 5" and "$nk import 5" all work.
 * @returns {{name:string, args:string[]}|null} name is lower-cased
 */
export function parseCommand(content, prefix) {
	const text = (content ?? "").trim();
	if (!text.startsWith(prefix)) return null;
	const [name, ...args] = text.slice(prefix.length).trim().split(/\s+/);
	return name ? { name: name.toLowerCase(), args } : null;
}

/** How a command is written in replies: "!import", but "$nk import" when the prefix ends in a letter or digit. */
export function commandText(prefix, name) {
	return `${prefix}${/\w$/.test(prefix) ? " " : ""}${name}`;
}

/** Whether a Fluxer member holds one of the privileged roles from config. */
export async function isPrivileged(fluxer, config, userId) {
	const allowed = config.fluxer.privilegedRoleIds;
	if (allowed.length === 0) return false;
	const roles = await fluxer.memberRoleIds(userId);
	return roles.some((r) => allowed.includes(r));
}
