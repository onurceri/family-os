import type { WebExtension } from '@famos/ui/slots';
import { api } from './api.js';
import { matchPage, ownerOf } from './contributions.js';
import { contributions, registerWebExtension } from './contributions.svelte.js';
import {
	type ExtensionList,
	importAll,
	packageFiles,
	parseExtensionList,
	sourceEntries,
} from './extension-loading.js';

/**
 * Registers the web half of every extension the server runs. Read what they contribute through
 * `contributions`, imported from here, so the registering has happened: the module waits for the
 * imports (top-level await), and so does everything that imports it.
 *
 * In the built app each extension is a package of its own, imported at run time from the list
 * the server writes into the shell; the import map gives it the app's Svelte, `@famos/ui` and the
 * rest of what is shared, so it runs in the same context as the app. The dev server compiles the
 * workspace's extension source instead (with hot reload), limited to the ones the API server runs.
 */
const failed = (id: string, error: unknown) =>
	console.error(`The extension ${id} could not be loaded and is left out`, error);

/** What the server wrote into the shell (empty in development). */
const list: ExtensionList = import.meta.env.DEV
	? { fingerprint: '', extensions: [] }
	: parseExtensionList(document.getElementById('famos-extensions')?.textContent);

/** The fingerprint of what this page loaded (the dev server reads it from the API). */
let fingerprint = list.fingerprint;

const loaded = import.meta.env.DEV ? await fromSource() : await fromPackages();
for (const ext of loaded) registerWebExtension(ext);

/**
 * The fingerprint of the extensions this page runs: when the server's differs, it runs other
 * ones (after an install and a restart) and the page should be loaded again.
 */
export const loadedFingerprint = (): string => fingerprint;

async function fromPackages(): Promise<WebExtension[]> {
	return importAll(
		list.extensions.map((ext) => ({
			id: ext.id,
			load: () => import(/* @vite-ignore */ ext.entry) as Promise<{ default: WebExtension }>,
		})),
		failed,
	);
}

async function fromSource(): Promise<WebExtension[]> {
	const { data } = await api.GET('/api/v1/core/extensions/loaded');
	fingerprint = data?.fingerprint ?? '';
	const modules = import.meta.glob<{ default: WebExtension }>(
		'../../../../extensions/*/src/web/index.ts',
	);
	return importAll(sourceEntries(modules, data?.extensions.map((e) => e.id) ?? []), failed);
}

/**
 * Asks the service worker to keep the packages' files for offline use (and to drop those of
 * packages the server no longer runs), once the app has opened.
 */
export function keepExtensionsOffline(): void {
	if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
	const files = packageFiles(list);
	void navigator.serviceWorker.ready.then((reg) =>
		reg.active?.postMessage({ type: 'CACHE_EXTENSIONS', files }),
	);
}

export { enabledOnly, ownerOf } from './contributions.js';
export { contributions };

/** The extension page for a path (see `matchPage`). */
export const pageFor = (pathname: string) => matchPage(pathname, contributions.pages);

/**
 * The app's own pages, from the SvelteKit route files (not loaded, only their paths): `/more`,
 * `/settings/ai`… Dynamic and catch-all routes are left out; extension pages are matched below.
 */
const APP_PAGES = new Set(
	Object.keys(import.meta.glob('../routes/**/+page.svelte'))
		.map((file) => file.slice('../routes'.length, -'/+page.svelte'.length) || '/')
		.filter((path) => !path.includes('[')),
);

/** Whether a path is a page of the app: its own, or one of an extension that is turned on. */
export function isAppPath(path: string, off: readonly string[] = []): boolean {
	if (APP_PAGES.has(path.replace(/\/+$/, '') || '/')) return true;
	const found = pageFor(path);
	return found !== undefined && !off.includes(ownerOf(found.page.id));
}
