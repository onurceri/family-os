import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The modules the host shares with extension packages. A package leaves them out of its bundle
 * (`@famos/pack` refuses one that does not) and gets the host's own instance here, so a schema it
 * builds passes the host's zod checks and its queries run on the host's Kysely.
 */
export const SHARED_MODULES: readonly string[] = ['@famos/sdk', 'zod', 'kysely', '@famos/time'];

/**
 * How a folder's imports are resolved:
 * - `package`: a built package. It may import the shared modules, `node:` modules and its own
 *   files; any other import is refused, since everything else must be inlined when it is built.
 * - `source`: an extension's workspace source (development and tests). Its own dependencies
 *   resolve as usual; only the shared modules are pointed at the host's.
 */
export type RootKind = 'package' | 'source';

interface Root {
	/** The folder as a `file:` URL that ends with a slash. */
	prefix: string;
	kind: RootKind;
	name: string;
}

const roots: Root[] = [];
let registered = false;

/**
 * Starts resolving the imports of code under `dir` by the rules of `kind`. Must be called before
 * anything under it is imported; may be called for any number of folders.
 */
export function guardImports(dir: string, kind: RootKind, name: string): void {
	// Node names a module by its real path, so the folder is compared by its real path too.
	const real = realpathSync(dir);
	const prefix = pathToFileURL(real.endsWith(sep) ? real : `${real}${sep}`).href;
	if (!roots.some((root) => root.prefix === prefix)) roots.push({ prefix, kind, name });
	if (registered) return;
	registered = true;
	const shared = sharedModuleUrls();
	// Synchronous and in the same thread: the rules apply from the first import on, and resolving
	// costs no message to a loader thread.
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const parent = context.parentURL;
			const root = parent ? roots.find((r) => parent.startsWith(r.prefix)) : undefined;
			if (!root) return nextResolve(specifier, context);
			if (SHARED_MODULES.includes(specifier)) {
				const url = shared?.[specifier];
				// From source (tsx, Vitest) the host's copy is whatever the host itself resolves.
				return url
					? { url, shortCircuit: true }
					: nextResolve(specifier, { ...context, parentURL: import.meta.url });
			}
			if (root.kind === 'source' || specifier.startsWith('node:')) {
				return nextResolve(specifier, context);
			}
			if (isRelative(specifier)) {
				const resolved = nextResolve(specifier, context);
				if (!resolved.url.startsWith(root.prefix)) {
					throw new Error(
						`The extension package ${root.name} imports ${specifier}, which lies outside its folder`,
					);
				}
				return resolved;
			}
			throw new Error(
				`The extension package ${root.name} imports ${specifier}, which the host does not share ` +
					`(shared: ${SHARED_MODULES.join(', ')} and node: modules)`,
			);
		},
	});
}

const isRelative = (specifier: string) => specifier.startsWith('./') || specifier.startsWith('../');

/**
 * The built server writes `shared/modules.json` beside its bundle: each shared module and the
 * file that exports the bundle's own instance of it. From source there is no such file.
 */
function sharedModuleUrls(): Record<string, string> | undefined {
	const file = new URL('./shared/modules.json', import.meta.url);
	if (file.protocol !== 'file:' || !existsSync(fileURLToPath(file))) return undefined;
	const listed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
	const urls: Record<string, string> = {};
	for (const specifier of SHARED_MODULES) {
		const path = listed[specifier];
		if (!path) throw new Error(`${fileURLToPath(file)} does not list ${specifier}`);
		urls[specifier] = new URL(path, file).href;
	}
	return urls;
}
