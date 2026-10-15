/**
 * How the app finds and imports its extensions, apart from the browser so it can be tested.
 * The server writes the list of what it runs into the shell (`famos-extensions`); each entry is
 * a package's web module, imported at run time through the import map, which hands it the app's
 * own Svelte, `@famos/ui` and the rest of what is shared.
 */

/** A package the server runs, as written into the shell. */
export interface ListedExtension {
	id: string;
	version: string;
	/** The web entry module's address. */
	entry: string;
	css?: string;
	/** Every web file of the package, for the service worker to keep for offline use. */
	files: string[];
}

export interface ExtensionList {
	fingerprint: string;
	extensions: ListedExtension[];
}

const EMPTY: ExtensionList = { fingerprint: '', extensions: [] };

const isString = (value: unknown): value is string => typeof value === 'string';

function isListed(value: unknown): value is ListedExtension {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		isString(v.id) &&
		isString(v.version) &&
		isString(v.entry) &&
		(v.css === undefined || isString(v.css)) &&
		Array.isArray(v.files) &&
		v.files.every(isString)
	);
}

/**
 * The list in the shell. A shell without one (an older server, a page saved to disk) or with one
 * that cannot be read gives no extensions rather than a broken app.
 */
export function parseExtensionList(text: string | null | undefined): ExtensionList {
	if (!text) return EMPTY;
	try {
		const value = JSON.parse(text) as { fingerprint?: unknown; extensions?: unknown };
		if (!isString(value.fingerprint) || !Array.isArray(value.extensions)) return EMPTY;
		return { fingerprint: value.fingerprint, extensions: value.extensions.filter(isListed) };
	} catch {
		return EMPTY;
	}
}

export interface Importable<T> {
	id: string;
	load: () => Promise<{ default: T }>;
}

/**
 * Imports every entry at once and keeps the ones that load, in the order given. One that fails
 * (a missing file, a bundle that throws) is reported and left out, so the rest of the app opens.
 */
export async function importAll<T>(
	entries: readonly Importable<T>[],
	onError: (id: string, error: unknown) => void,
): Promise<T[]> {
	const settled = await Promise.allSettled(entries.map((entry) => entry.load()));
	const loaded: T[] = [];
	settled.forEach((result, i) => {
		const entry = entries[i] as Importable<T>;
		if (result.status === 'fulfilled') loaded.push(result.value.default);
		else onError(entry.id, result.reason);
	});
	return loaded;
}

/**
 * The extensions the dev server compiles from source, limited to the ones the API server runs.
 * Keys are the source files (`…/extensions/<folder>/src/web/index.ts`); the folder is the id.
 */
export function sourceEntries<T>(
	modules: Readonly<Record<string, () => Promise<{ default: T }>>>,
	running: readonly string[],
): Importable<T>[] {
	return Object.entries(modules)
		.map(([file, load]) => ({
			id: /\/extensions\/([^/]+)\/src\/web\//.exec(file)?.[1] ?? '',
			load,
		}))
		.filter((entry) => running.includes(entry.id))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** Every file of the listed packages, for the service worker. */
export const packageFiles = (list: ExtensionList): string[] =>
	list.extensions.flatMap((ext) => ext.files);
