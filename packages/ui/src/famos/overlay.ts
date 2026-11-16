/**
 * Whether a dialog, a sheet or a side panel is open in the page. Each of them renders only while
 * open and says `role="dialog"` (a native `<dialog>` is open with its `open` attribute), so the page
 * itself tells; nothing has to register. Used by what would otherwise cover them, such as the
 * photo slideshow of an idle screen.
 */
export function overlayOpen(root: ParentNode = document): boolean {
	return root.querySelector('dialog[open], [role="dialog"]') !== null;
}

/**
 * Makes everything in the page except `el` (and the path to it) inert, so a screen reader and the
 * keyboard reach only `el` while it covers the page. The returned function puts each element back
 * as it was; one that was inert before stays inert.
 */
export function inertBeneath(el: HTMLElement): () => void {
	const changed: Element[] = [];
	for (let node: HTMLElement | null = el; node?.parentElement; node = node.parentElement) {
		for (const sibling of node.parentElement.children) {
			if (sibling === node || sibling.hasAttribute('inert')) continue;
			sibling.setAttribute('inert', '');
			changed.push(sibling);
		}
	}
	return () => {
		for (const sibling of changed) sibling.removeAttribute('inert');
	};
}
