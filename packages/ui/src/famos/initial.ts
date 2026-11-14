/**
 * The letter drawn in a member's avatar: the first user-perceived character of the name, so an
 * emoji, a flag or a joined family stays whole. Without `Intl.Segmenter` the first code point is
 * used, which still never cuts a surrogate pair.
 */
export function initialOf(name: string): string {
	const text = name.trim();
	if (text === '') return '';
	let first: string | undefined;
	if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
		const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
		first = segments[Symbol.iterator]().next().value?.segment;
	} else first = Array.from(text)[0];
	return (first ?? '').toLocaleUpperCase();
}
