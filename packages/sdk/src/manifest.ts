import { z } from 'zod';

/**
 * The version of the contract between the host and its extensions (this package's exports).
 * An extension names the range it was built against in its manifest's `sdk`; the host refuses to
 * start one whose range this version does not satisfy. Raise the minor for an addition, the major
 * for a change that breaks an extension built against the old one (while below 1.0, the minor).
 */
export const SDK_VERSION = '0.5.1';

const EXTENSION_ID = /^[a-z][a-z0-9]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CARET = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ACTION_ID = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/;
const CAPABILITY_ID = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const TABLE_PREFIX = /^[a-z][a-z0-9_]*_$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;

/** The contracts between the host and one extension that the host's channels use. */
export const HOST_CONTRACTS = ['shareTarget', 'conversation'] as const;
export type HostContract = (typeof HOST_CONTRACTS)[number];

const ExtensionIdSchema = z.string().regex(EXTENSION_ID, 'use lowercase letters and digits');

/**
 * What an extension is and what it reaches, as static JSON in the `famos` field of its
 * package.json, so it can be read before any of the extension's code runs. The host checks it
 * against the code when it builds the registry.
 */
export const ExtensionManifestSchema = z.strictObject({
	/** Lowercase identifier: the namespace of everything it declares and its API path segment. */
	id: ExtensionIdSchema,
	/** The extension's own version (`major.minor.patch`). */
	version: z.string().regex(VERSION, 'use major.minor.patch'),
	/** The SDK versions it works with, as a caret range: `^0.1.0`. */
	sdk: z.string().regex(CARET, 'use a caret range such as ^0.1.0'),
	/** Extensions that must be present; their migrations run first. */
	dependsOn: z.array(ExtensionIdSchema).default([]),
	/**
	 * Extensions it works with when they are present and does without otherwise. They do not
	 * change the order extensions load in: no extension's tables may lean on another's.
	 */
	optional: z.array(ExtensionIdSchema).default([]),
	/** The prefix of every table it creates; `<id>_` when left out. */
	tablePrefix: z
		.string()
		.regex(TABLE_PREFIX, 'use lowercase letters, digits and _, ending in _')
		.optional(),
	/** The ids of the capabilities its code declares, all of them. */
	capabilities: z.array(z.string().regex(CAPABILITY_ID)).default([]),
	/**
	 * The actions of other extensions (or core) its code runs by id. Each belongs to core or to an
	 * extension in `dependsOn` or `optional`.
	 */
	calls: z.array(z.string().regex(ACTION_ID)).default([]),
	/**
	 * The host contracts it implements: `shareTarget` receives what members share from outside
	 * the app, `conversation` answers what they ask from there. Each has at most one provider in an
	 * installation.
	 */
	// Read as strings first: package.json is imported as JSON, whose arrays hold plain strings.
	provides: z
		.array(z.string())
		.pipe(z.array(z.enum(HOST_CONTRACTS)))
		.default([]),
	/** What it may reach outside the household. Left out: nothing. */
	network: z
		.strictObject({
			/** Hosts it calls itself (`api.example.org`). */
			hosts: z.array(z.string().regex(HOST)).optional(),
			/** Whether it fetches addresses a person typed (a calendar subscription). */
			userUrls: z.boolean().optional(),
			/** Whether a person may let it reach an address on the home network. */
			local: z.boolean().optional(),
		})
		.optional(),
});

export type ExtensionManifest = z.output<typeof ExtensionManifestSchema>;
/** The manifest as written in package.json, before defaults are filled in. */
export type ExtensionManifestInput = z.input<typeof ExtensionManifestSchema>;

/**
 * Names the host keeps for itself: core and the infrastructure adapters (identity's tables are
 * `auth_…`, the model settings `ai_…`, the job queue `queue_…`). No extension may take one as its
 * id, nor a table prefix that overlaps `<name>_`, or it would reach the host's tables through its
 * own scope. `app` is the namespace of the app's own texts, which an extension's would replace.
 */
export const RESERVED_NAMES = [
	'core',
	'app',
	'auth',
	'identity',
	'ai',
	'queue',
	'email',
	'backup',
	'telegram',
	'webpush',
] as const;

/** The table prefixes the host keeps for itself (see `RESERVED_NAMES`). */
export const RESERVED_TABLE_PREFIXES: readonly string[] = RESERVED_NAMES.map((name) => `${name}_`);

/** Why an extension may not use this id and table prefix, or null when it may. */
export function reservedClash(id: string, prefix: string): string | null {
	if ((RESERVED_NAMES as readonly string[]).includes(id)) return `its id "${id}" is the host's`;
	const taken = RESERVED_TABLE_PREFIXES.find((p) => p.startsWith(prefix) || prefix.startsWith(p));
	return taken ? `its table prefix "${prefix}" overlaps the host's "${taken}"` : null;
}

/** The table prefix an extension's tables use. */
export const tablePrefixOf = (manifest: ExtensionManifest): string =>
	manifest.tablePrefix ?? `${manifest.id}_`;

/**
 * Whether `version` satisfies the caret range `range`, as npm reads it: `^1.2.3` takes 1.x.y
 * from 1.2.3 on, `^0.2.3` takes 0.2.y from 0.2.3 on, `^0.0.3` takes only 0.0.3.
 */
export function satisfiesCaret(version: string, range: string): boolean {
	const v = VERSION.exec(version);
	const r = CARET.exec(range);
	if (!v || !r) return false;
	const [major, minor, patch] = v.slice(1).map(Number) as [number, number, number];
	const [rMajor, rMinor, rPatch] = r.slice(1).map(Number) as [number, number, number];
	if (major !== rMajor) return false;
	if (rMajor > 0) return minor > rMinor || (minor === rMinor && patch >= rPatch);
	if (minor !== rMinor) return false;
	if (rMinor > 0) return patch >= rPatch;
	return patch === rPatch;
}

/** Reads a manifest, naming the extension and the field when it is malformed. */
export function parseManifest(input: unknown): ExtensionManifest {
	const result = ExtensionManifestSchema.safeParse(input);
	if (result.success) return result.data;
	const id =
		typeof input === 'object' && input !== null && 'id' in input ? String(input.id) : '(no id)';
	const issues = result.error.issues
		.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
		.join('; ');
	throw new Error(`Invalid manifest of extension "${id}": ${issues}`);
}
