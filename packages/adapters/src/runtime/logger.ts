import type { Logger } from '@famos/sdk';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const;
type LevelName = keyof typeof LEVELS;

/** Keys whose values are replaced at any depth: these exact names, or any name holding one of the parts. */
const SECRET_NAMES = new Set(['pin', 'key']);
const SECRET_PARTS = [
	'password',
	'passphrase',
	'secret',
	'token',
	'apikey',
	'cookie',
	'authorization',
	'bearer',
	'credential',
	'privatekey',
	'setupcode',
];

const isSecretKey = (key: string) => {
	const name = key.toLowerCase().replace(/[-_]/g, '');
	return SECRET_NAMES.has(name) || SECRET_PARTS.some((part) => name.includes(part));
};

/**
 * Secrets that can sit inside free text (an error message, a URL): FamilyOS keys and tokens, a bearer
 * header, the password in a URL, and query parameters named like a secret.
 */
const SECRET_IN_TEXT: [RegExp, string][] = [
	[/\bfamos_[A-Za-z0-9_-]{8,}/g, 'famos_[Redacted]'],
	[/\b(Bearer\s+)[^\s"',;]+/gi, '$1[Redacted]'],
	[/(\/\/[^/\s:@]+:)[^/\s@]+@/g, '$1[Redacted]@'],
	[
		/([?&](?:[A-Za-z0-9_-]*(?:token|secret|password|passphrase|apikey|api_key|signature|sig)|key)=)[^&#\s"']+/gi,
		'$1[Redacted]',
	],
];

const scrubText = (text: string) =>
	SECRET_IN_TEXT.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);

function scrub(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === 'string') return scrubText(value);
	if (value === null || typeof value !== 'object') return value;
	if (seen.has(value)) return '[Circular]';
	seen.add(value);
	if (value instanceof Error) return serializeError(value, seen);
	if (Array.isArray(value)) return value.map((v) => scrub(v, seen));
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value))
		out[key] = isSecretKey(key) ? '[Redacted]' : scrub(child, seen);
	return out;
}

/** An error as plain fields, wherever it sits; its text is scrubbed like any other. */
function serializeError(e: Error, seen: WeakSet<object>): Record<string, unknown> {
	return {
		type: e.constructor.name,
		message: scrubText(e.message),
		...(e.stack && { stack: scrubText(e.stack) }),
		...(e.cause !== undefined && { cause: scrub(e.cause, seen) }),
	};
}

export interface LineLoggerOptions {
	level?: string;
	/** Where lines go; stdout by default. */
	write?: (line: string) => void;
	now?: () => number;
}

/** JSON lines in pino's shape (`level` number, `time` epoch ms, `msg`, merged fields). */
export function createLineLogger(options: LineLoggerOptions = {}): Logger {
	const threshold = LEVELS[(options.level ?? 'info') as LevelName] ?? LEVELS.info;
	const write = options.write ?? ((line) => void process.stdout.write(line));
	const now = options.now ?? Date.now;

	const make = (bindings: object): Logger => {
		const emit = (level: LevelName) => (obj: object, msg?: string) => {
			if (LEVELS[level] < threshold) return;
			const fields = scrub({ ...bindings, ...obj }, new WeakSet()) as Record<string, unknown>;
			const record = {
				level: LEVELS[level],
				time: now(),
				...fields,
				...(msg ? { msg: scrubText(msg) } : {}),
			};
			let line: string;
			try {
				line = JSON.stringify(record);
			} catch {
				line = JSON.stringify({
					level: LEVELS[level],
					time: record.time,
					msg,
					unserializable: true,
				});
			}
			write(`${line}\n`);
		};
		return {
			debug: emit('debug'),
			info: emit('info'),
			warn: emit('warn'),
			error: emit('error'),
			child: (more) => make({ ...bindings, ...more }),
		};
	};
	return make({});
}
