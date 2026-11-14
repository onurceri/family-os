/**
 * Whether the page now shows a different list than the one whose rows it holds. Rows, the
 * cart and the "read once" mark belong to one list: when the shown list changes (or goes away)
 * they are dropped at once, so the old list is never drawn or ticked under the new one while
 * the new read is on its way, or after it failed.
 */
export function listChanged(previous: string | undefined, next: string | undefined): boolean {
	return previous !== next;
}
