/** Names as a sentence lists them, in the reader's language: "Mara", "Mara and Tom", "A, B and C". */
export function joinNames(
	names: readonly string[],
	t: (key: string, options?: Record<string, unknown>) => string,
): string {
	if (names.length <= 1) return names[0] ?? '';
	return t('app:today_names_and', {
		list: names.slice(0, -1).join(', '),
		last: names.at(-1),
	});
}

/**
 * Why a page is "View only", in one line: the role of the viewer lets them look, and who can change
 * what that role may do, by name when the family's roles could be read (never the viewer alone:
 * they would not be reading this), otherwise in general words.
 */
export function viewOnlyLine(
	managers: readonly { id: string; displayName: string }[] | undefined,
	meId: string | undefined,
	t: (key: string, options?: Record<string, unknown>) => string,
): string {
	const others = (managers ?? []).filter((m) => m.id !== meId).map((m) => m.displayName);
	return others.length > 0
		? t('app:view_only_why', { who: joinNames(others, t) })
		: t('app:view_only_why_unnamed');
}

/**
 * Where the line opens: under the pill, its end at the pill's end when that fits, never closer
 * than `gutter` to either side of the window (a pill in the middle of a phone's head).
 */
export function bubblePlace(
	anchor: { left: number; right: number; bottom: number },
	width: number,
	viewport: number,
	rtl = false,
	gutter = 16,
): { left: number; top: number } {
	const preferred = rtl ? anchor.left : anchor.right - width;
	const left = Math.max(gutter, Math.min(preferred, viewport - gutter - width));
	return { left, top: anchor.bottom + 8 };
}
