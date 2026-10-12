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
 * Whether a text names the thing titled `title`: every significant word of the title is a whole
 * word of the text (a trailing plural "s" does not matter), in any order. Unlike
 * `labelNamesTitle` the text may say more but never less, so "Got the E27 light bulbs" names
 * "Light bulbs E27" and "Got the picture wire" does not name "Picture hooks". A title without a
 * significant word ("4") must appear in the text as written.
 */
export function textNamesTitle(text: string, title: string): boolean {
	const have = significantWords(text);
	const wanted = significantWords(title);
	if (wanted.length === 0) {
		const plain = (s: string) => s.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
		return plain(title) !== '' && plain(text).includes(plain(title));
	}
	return wanted.every((w) => have.some((h) => sameWord(w, h)));
}
