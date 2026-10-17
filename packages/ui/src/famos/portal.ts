/**
 * Moves an element to the end of `document.body` while it is shown. An overlay drawn inside a
 * transformed parent (a tilted note on the board) would otherwise be placed and clipped by that
 * parent instead of the window, since a transform makes `position: fixed` relative to it. Give it
 * to the only element of its `{#if}` block, so Svelte still finds the node to remove.
 */
export function portal(node: HTMLElement): { destroy(): void } {
	document.body.append(node);
	return { destroy: () => node.remove() };
}
