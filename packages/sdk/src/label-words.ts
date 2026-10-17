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

/**
 * The codes and numbers of a label: every token with a digit in it ("1b", "u13", "10", "29"), and
 * a number glued to a letter or two by a dot or a dash ("8.b" is "8b"). They tell things apart in
 * any language: "Class 1B trip" is not "Class 3B trip" and "Pay 10 EUR" is not "Pay 18 EUR",
 * although all their words are shared. Anything in brackets is left out, as for the words.
 */
function codeTokens(text: string): string[] {
	const bare = text.replace(/\([^)]*\)|\[[^\]]*\]/gu, ' ');
	const glued = bare.replace(
		/(?<![\p{L}\p{N}])(\p{N}+)[.-](\p{L}{1,2})(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(\p{L}{1,2})[.-](\p{N}+)(?![\p{L}\p{N}])/gu,
		'$1$2$3$4',
	);
	const tokens = glued.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	return [...new Set(tokens.filter((t) => /\p{N}/u.test(t)))];
}

const sameWord = (a: string, b: string) => a === b || a === `${b}s` || b === `${a}s`;

/**
 * Whether the person's own words (`label`) name the thing titled `title`: the significant words
 * of one side are all whole words of the other (a trailing plural "s" does not matter), so
 * "the bread" and "Bread" meet, "Milk" is in "Oat milk", but "Dental cleaning" is not
 * "Dentist checkup". Codes and numbers tell things apart: when both sides have some, one side's
 * must all be the other's ("Class 1B trip" is not "Class 3B trip"). A side without a significant
 * word ("4") must equal the other.
 */
export function labelNamesTitle(label: string, title: string): boolean {
	const wanted = significantWords(label);
	const have = significantWords(title);
	if (wanted.length === 0 || have.length === 0) {
		const plain = (s: string) => s.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
		return plain(label) !== '' && plain(label) === plain(title);
	}
	const within = (a: string[], b: string[]) => a.every((w) => b.some((h) => sameWord(w, h)));
	if (!(within(wanted, have) || within(have, wanted))) return false;
	// When both name codes or numbers, one side's must all be the other's.
	const codes = [codeTokens(label), codeTokens(title)] as const;
	if (codes[0].length > 0 && codes[1].length > 0) {
		const inside = (a: string[], b: string[]) => a.every((c) => b.includes(c));
		return inside(codes[0], codes[1]) || inside(codes[1], codes[0]);
	}
	return true;
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

const MIN_STEM = 4;

/** Whether two words are one word in different forms: one starts the other and is long enough to mean it. */
function sameStem(a: string, b: string): boolean {
	if (a === b) return true;
	const [short, long] = [...a].length <= [...b].length ? [a, b] : [b, a];
	return [...short].length >= MIN_STEM && long.startsWith(short);
}

/**
 * Whether a search text finds `haystack`, for the filters of read tools (never for deciding which
 * item a change names: that is `labelNamesTitle`, which stays strict). The text is found when it
 * is contained as written, or when each of its words is a word of the haystack or a form of one:
 * one word starts the other and the shorter has at least four letters ("swim" and "swimming").
 * Letters only, in any language; no word lists.
 */
export function searchFinds(query: string, haystack: string): boolean {
	const lower = (s: string) => s.toLocaleLowerCase();
	const wanted = lower(query).trim();
	if (wanted === '') return true;
	if (lower(haystack).includes(wanted)) return true;
	const words = (s: string) => lower(s).match(/[\p{L}\p{N}]+/gu) ?? [];
	const have = words(haystack);
	const asked = words(query);
	return asked.length > 0 && asked.every((w) => have.some((h) => sameStem(w, h)));
}
