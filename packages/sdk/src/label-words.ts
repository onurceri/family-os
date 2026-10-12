/**
 * Words of a label or a title that tell things apart: letters and digits only, in any language,
 * lower case. Anything in brackets (a date, a note), numbers, and words of one or two characters
 * say nothing about which thing is meant. The words come from the data; nothing here knows a
 * language.
 */
export function significantWords(text: string): string[] {
	const bare = text.replace(/\([^)]*\)|\[[^\]]*\]/gu, ' ');
	const words = bare.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	return words.filter((w) => [...w].length > 2 && !/^\p{N}+$/u.test(w));
}

const sameWord = (a: string, b: string) => a === b || a === `${b}s` || b === `${a}s`;

/**
 * Whether the person's own words (`label`) name the thing titled `title`: the significant words
 * of one side are all whole words of the other (a trailing plural "s" does not matter), so
 * "the bread" and "Bread" meet, "Milk" is in "Oat milk", but "Dental cleaning" is not
 * "Dentist checkup". A side without a significant word ("4") must equal the other.
 */
export function labelNamesTitle(label: string, title: string): boolean {
	const wanted = significantWords(label);
	const have = significantWords(title);
	if (wanted.length === 0 || have.length === 0) {
		const plain = (s: string) => s.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
		return plain(label) !== '' && plain(label) === plain(title);
	}
	const within = (a: string[], b: string[]) => a.every((w) => b.some((h) => sameWord(w, h)));
	return within(wanted, have) || within(have, wanted);
}

/**
 * For each title, how much of it a text names: the share of its distinct significant words that
 * the text says as whole words (a trailing plural "s" does not matter), each word weighted by how
 * rare it is among these titles. A word most titles share ("the", "and" in any language) says
 * little about which one is meant; the weights come from the titles themselves, so nothing here
 * knows a language. "Got the picture wire" names all of "Picture wire" and half of "Picture
 * hooks"; a long task that only shares "the" scores near nothing. A title without a significant
 * word ("4") scores 1 when the text contains it as written, else 0.
 */
export function namedShares(text: string, titles: readonly string[]): number[] {
	const have = significantWords(text);
	const says = (w: string) => have.some((h) => sameWord(w, h));
	const words = titles.map((title) => [...new Set(significantWords(title))]);
	const titlesWith = (w: string) => words.filter((ws) => ws.some((x) => sameWord(x, w))).length;
	const weight = (w: string) => Math.log(1 + titles.length / Math.max(1, titlesWith(w)));
	const plain = (s: string) => s.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
	return titles.map((title, i) => {
		const ws = words[i] as string[];
		if (ws.length === 0) return plain(title) !== '' && plain(text).includes(plain(title)) ? 1 : 0;
		const total = ws.reduce((sum, w) => sum + weight(w), 0);
		const named = ws.filter(says).reduce((sum, w) => sum + weight(w), 0);
		return named / total;
	});
}
