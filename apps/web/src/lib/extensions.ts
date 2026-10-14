import type { WebExtension } from '@famos/ui/slots';
import { matchPage, ownerOf } from './contributions.js';
import { contributions, registerWebExtension } from './contributions.svelte.js';

/**
 * Registers every extension's `./web` entry, found at build time. Extensions are first-party
 * workspace packages, so a glob over the monorepo is enough; no runtime loading. Read what they
 * contribute through `contributions`, imported from here, so the registering has happened.
 */
const modules = import.meta.glob<{ default: WebExtension }>(
	'../../../../extensions/*/src/web/index.ts',
	{ eager: true },
);
for (const m of Object.values(modules)) registerWebExtension(m.default);

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
