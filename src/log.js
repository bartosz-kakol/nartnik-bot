const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

export function setLogLevel(level) {
	if (!(level in LEVELS)) throw new Error(`Unknown log level "${level}"`);
	threshold = LEVELS[level];
}

function write(level, scope, args) {
	if (LEVELS[level] < threshold) return;

	const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
	const out = level === "error" || level === "warn" ? console.error : console.log;
	
	out(line, ...args);
}

export function createLogger(scope) {
	return {
		debug: (...args) => write("debug", scope, args),
		info: (...args) => write("info", scope, args),
		warn: (...args) => write("warn", scope, args),
		error: (...args) => write("error", scope, args),
	};
}
