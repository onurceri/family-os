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
 * How many significant words of `title` a text says as whole words (a trailing plural "s" does
 * not matter), in any order. "I paid the swim course fee" says four of "Pay the swim course
 * fee"; "Got the picture wire" says one of "Picture hooks" and two of "Picture wire". A title
 * without a significant word ("4") counts 1 when the text contains it as written, else 0.
 */
export function wordsNamed(text: string, title: string): number {
	const have = significantWords(text);
	const wanted = significantWords(title);
	if (wanted.length === 0) {
		const plain = (s: string) => s.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
		return plain(title) !== '' && plain(text).includes(plain(title)) ? 1 : 0;
	}
	return wanted.filter((w) => have.some((h) => sameWord(w, h))).length;
}
