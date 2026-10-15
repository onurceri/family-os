import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';
import { SHARED_WEB } from './shared.ts';

/** Where the app's build writes which file holds each shared module, relative to its output. */
export const SHARED_MODULES_FILE = '_app/shared-modules.json';

export interface SharedModulesOptions {
	/** The specifiers to share. Defaults to `SHARED_WEB`. */
	specifiers?: readonly string[];
	/** The environment that builds the browser app (SvelteKit's is `client`). */
	environment?: string;
	/** Shared modules provided without some of their exports (`TRIM_WEB` by default). */
	trim?: Readonly<Record<string, Trim>>;
}

/**
 * Exports a shared module is provided without. A shared module's chunk keeps every export it
 * has, so tree shaking leaves nothing out of it; this leaves out what no extension should reach
 * for and the app does not want to load. `namespaces` names the module each namespace export
 * comes from, so that one is rebuilt without the omitted exports too.
 */
export interface Trim {
	omit: readonly string[];
	namespaces?: Readonly<Record<string, string>>;
}

/**
 * zod's message translations: every language zod has (as `locales`, and again as
 * `core.locales`), a third of zod. The messages the family sees come from the app's own
 * catalogs, so the shared zod is the one without them.
 */
export const TRIM_WEB: Readonly<Record<string, Trim>> = {
	zod: { omit: ['locales'], namespaces: { core: 'zod/v4/core' } },
};

const TRIMMED = '\0famos-shared:';

/**
 * Makes the app's own build the provider of the modules extension packages share with it. Each
 * shared specifier becomes an entry chunk of the app with its exports kept exactly as the module
 * declares them, and the app's code imports the same chunk, so a package that reaches
 * `svelte/internal/client` or `@famos/ui/app` through the import map gets the very instance the
 * app runs: one Svelte runtime, one app context, one zod. The chunk of every specifier is listed
 * in `_app/shared-modules.json`, which the server turns into the import map.
 */
export function sharedModules(options: SharedModulesOptions = {}): Plugin {
	const specifiers = options.specifiers ?? SHARED_WEB;
	const environment = options.environment ?? 'client';
	const trim = options.trim ?? TRIM_WEB;
	const refs = new Map<string, string>();
	return {
		name: 'famos:shared-modules',
		apply: 'build',
		applyToEnvironment: (env) => env.name === environment,
		buildStart() {
			refs.clear();
			for (const id of specifiers) {
				refs.set(
					id,
					this.emitFile({
						type: 'chunk',
						id: trim[id] ? `${TRIMMED}${id}` : id,
						name: `shared/${chunkName(id)}`,
						preserveSignature: 'strict',
					}),
				);
			}
		},
		resolveId(id) {
			return id.startsWith(TRIMMED) ? id : undefined;
		},
		async load(id) {
			if (!id.startsWith(TRIMMED)) return undefined;
			const specifier = id.slice(TRIMMED.length);
			const resolve = async (name: string) => {
				const resolved = await this.resolve(name);
				if (!resolved) throw new Error(`Cannot resolve the shared module ${name}`);
				return resolved.id;
			};
			return trimmedModule(specifier, resolve, trim[specifier] ?? { omit: [] });
		},
		generateBundle() {
			const files: Record<string, string> = {};
			for (const [id, ref] of refs) files[id] = this.getFileName(ref);
			this.emitFile({
				type: 'asset',
				fileName: SHARED_MODULES_FILE,
				source: `${JSON.stringify(files, null, '\t')}\n`,
			});
		},
	};
}

/** `@famos/ui/app` → `famos-ui-app`, `svelte/internal/client` → `svelte-internal-client`. */
export const chunkName = (specifier: string): string =>
	specifier.replace(/^@/, '').replace(/[^a-zA-Z0-9]+/g, '-');

const isNamespace = (value: unknown): boolean =>
	Object.prototype.toString.call(value) === '[object Module]';

/**
 * A module that re-exports `specifier` without the omitted exports. Namespaces are rebuilt as
 * frozen objects of the same members minus the omitted ones: a namespace of the module's own
 * exports (zod's `z`, also its default), and those `trim.namespaces` names (zod's `core`). The
 * members are the very same functions and classes, so a schema made through it is one of the app's.
 */
export async function trimmedModule(
	specifier: string,
	resolve: (specifier: string) => Promise<string>,
	trim: Trim,
): Promise<string> {
	const load = async (name: string) =>
		(await import(pathToFileURL(await resolve(name)).href)) as Record<string, unknown>;
	const mod = await load(specifier);
	const keep = (name: string) => name !== 'default' && !trim.omit.includes(name);
	const names = Object.keys(mod).filter(keep);
	const isOwnNamespace = (name: string) =>
		isNamespace(mod[name]) && Object.keys(mod[name] as object).every((member) => member in mod);
	const rebuiltFrom = trim.namespaces ?? {};
	const plain = names.filter((name) => !isOwnNamespace(name) && !(name in rebuiltFrom));
	const lines: string[] = [];
	// Local names of their own: an export may be named like a keyword (zod's `enum`, `null`).
	let next = 0;
	const importNames = (from: string, list: readonly string[]) => {
		const local = new Map(list.map((name) => [name, `_${next++}`]));
		lines.push(
			`import { ${list.map((name) => `${name} as ${local.get(name)}`).join(', ')} } from ${JSON.stringify(from)};`,
		);
		return local;
	};
	const freeze = (local: string, members: [string, string][]) =>
		lines.push(
			`const ${local} = Object.freeze({ ${members.map(([key, value]) => `${JSON.stringify(key)}: ${value}`).join(', ')} });`,
		);
	const locals = importNames(specifier, plain);
	for (const [name, from] of Object.entries(rebuiltFrom)) {
		if (!names.includes(name)) continue;
		const inner = Object.keys(await load(from)).filter(keep);
		const innerLocals = importNames(from, inner);
		const local = `_${next++}`;
		freeze(local, [...innerLocals]);
		locals.set(name, local);
	}
	const exported = [...locals];
	for (const name of names.filter(isOwnNamespace)) {
		const local = `_${next++}`;
		const members = Object.keys(mod[name] as object).filter(keep);
		freeze(
			local,
			members.flatMap((member) => {
				const value = locals.get(member);
				return value ? [[member, value] as [string, string]] : [];
			}),
		);
		locals.set(name, local);
		exported.push([name, local]);
	}
	lines.push(`export { ${exported.map(([name, local]) => `${local} as ${name}`).join(', ')} };`);
	const fallback = names.find((name) => isOwnNamespace(name) && mod[name] === mod.default);
	if (fallback) lines.push(`export default ${locals.get(fallback)};`);
	else if ('default' in mod) lines.push(`export { default } from ${JSON.stringify(specifier)};`);
	return `${lines.join('\n')}\n`;
}
