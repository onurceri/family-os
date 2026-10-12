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
 * Whether the person's own words (`label`) name the thing titled `title`: every significant word
 * of the label is a whole word of the title (a trailing plural "s" does not matter). "Milk" is in
 * "Oat milk", but "Dental cleaning" is not in "Dentist checkup". A label without a significant
 * word ("4") must be the title itself.
 */
export function labelNamesTitle(label: string, title: string): boolean {
	const wanted = significantWords(label);
	if (wanted.length === 0) {
		const plain = (s: string) => s.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
		return plain(label) !== '' && plain(label) === plain(title);
	}
	const have = significantWords(title);
	return wanted.every((w) => have.some((h) => sameWord(w, h)));
}
