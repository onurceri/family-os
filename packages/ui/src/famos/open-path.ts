import { beginWork } from './work.svelte.js';

/**
 * Opens an in-app path through the router. Extensions cannot import the app's navigation, but
 * the router handles clicks on links, including one made here. `replace` swaps the current
 * history entry instead of adding one (for opening a default, not a step the person took).
 * `noScroll` keeps the scroll position (the page only changes what it shows).
 *
 * The router starts a link's navigation only after the next frame and a task (or 100 ms
 * without frames), to let the browser paint first; the app counts a navigation as work only
 * from when it starts. A page that opens its first item by itself (ListDetail) would look done
 * in between, and the page gate could show the list with an empty item, so the wait counts as
 * work too. It ends after the router's own wait, whichever way that ends.
 */
export function openPath(
	href: string,
	options: { replace?: boolean; noScroll?: boolean } = {},
): void {
	const link = document.createElement('a');
	link.href = href;
	if (options.replace) link.setAttribute('data-sveltekit-replacestate', '');
	if (options.noScroll) link.setAttribute('data-sveltekit-noscroll', '');
	document.body.append(link);
	const end = beginWork();
	// The router's click handler registers its frame and fallback timer during `click()`, so these,
	// registered after it, always run after the router's.
	link.click();
	link.remove();
	requestAnimationFrame(() => setTimeout(end, 0));
	setTimeout(end, 100);
}
