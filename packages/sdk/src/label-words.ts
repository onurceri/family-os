/**
 * Text in lower case by the rules of `language` ("TOPLANTI" is "toplantı" in Turkish); a tag the
 * runtime does not know lower-cases by the default rules rather than failing.
 */
export function lowerIn(text: string, language?: string): string {
	try {
		return text.toLocaleLowerCase(language || undefined);
	} catch {
		return text.toLocaleLowerCase();
	}
}

/**
 * Words of a label or a title that tell things apart: letters and digits only, in any language,
 * lower case (by the rules of `language`, when given). Anything in brackets (a date, a note),
 * numbers, and words of one or two characters say nothing about which thing is meant. The words
 * come from the data; nothing here knows a language.
 */
export function significantWords(text: string, language?: string): string[] {
	const bare = text.replace(/\([^)]*\)|\[[^\]]*\]/gu, ' ');
	const words = lowerIn(bare, language).match(/[\p{L}\p{N}]+/gu) ?? [];
	return words.filter((w) => [...w].length > 2 && !/^\p{N}+$/u.test(w));
}

const collators = new Map<string, Intl.Collator>();

/**
 * The collator that says whether two words are one word in a language: case and accents aside
 * ("Süt" and "sut", "CAFÉ" and "cafe"), by the language's own alphabet. A tag `Intl` does not
 * know falls back to the root collation rather than failing.
 */
function collatorFor(language: string | undefined): Intl.Collator {
	const key = language ?? '';
	let found = collators.get(key);
	if (!found) {
		try {
			found = new Intl.Collator(language || undefined, { sensitivity: 'base' });
		} catch {
			found = new Intl.Collator(undefined, { sensitivity: 'base' });
		}
		collators.set(key, found);
	}
	return found;
}

/** What the word helpers need to know: the language the words are compared in. */
export interface WordOptions {
	/** The family language (`tr`, `en`); its alphabet decides which letters are one letter. */
	language?: string;
}

/**
 * Whether two words are the same word, whole: equal but for case and accents in `language`.
 * A word in another form ("lessons", "sütü") is a different word here; a caller that wants
 * forms to count asks for them on purpose (`sameStemIn`).
 */
export function sameWordIn(language?: string): (a: string, b: string) => boolean {
	const collator = collatorFor(language);
	return (a, b) => a === b || collator.compare(a, b) === 0;
}

/** At least this many letters before a shorter word may be another form of a longer one. */
const MIN_STEM = 4;
/** A form adds at most this many letters to the word it is a form of ("lesson", "lessons"). */
const MAX_ENDING = 2;

/**
 * Whether two words may be one word in different forms: the shorter has at least four letters,
 * the longer starts with it (case and accents aside) and adds a short ending. Letters only, in
 * any language: no list of endings. A guess, so it never decides on its own that two things are
 * the same.
 */
export function sameStemIn(language?: string): (a: string, b: string) => boolean {
	const same = sameWordIn(language);
	return (a, b) => {
		if (same(a, b)) return true;
		const [short, long] = [...a].length <= [...b].length ? [[...a], [...b]] : [[...b], [...a]];
		if (short.length < MIN_STEM || long.length - short.length > MAX_ENDING) return false;
		return same(long.slice(0, short.length).join(''), short.join(''));
	};
}

/** The words once each, by `same`. */
export function distinctWords(
	words: readonly string[],
	same: (a: string, b: string) => boolean,
): string[] {
	const out: string[] = [];
	for (const w of words) if (!out.some((o) => same(o, w))) out.push(w);
	return out;
}

/**
 * For each title, how much of it a text names: the share of its distinct significant words that
 * the text says as whole words (case and accents aside, in `language`), each word weighted by how
 * rare it is among these titles. A word most titles share ("the", "and" in any language) says
 * little about which one is meant; the weights come from the titles themselves, so nothing here
 * knows a language. "Got the picture wire" names all of "Picture wire" and half of "Picture
 * hooks"; a long task that only shares "the" scores near nothing. A title without a significant
 * word ("4") scores 1 when the text contains it as written, else 0.
 */
export function namedShares(
	text: string,
	titles: readonly string[],
	options: WordOptions = {},
): number[] {
	const sameWord = sameWordIn(options.language);
	const have = significantWords(text, options.language);
	const says = (w: string) => have.some((h) => sameWord(w, h));
	const words = titles.map((title) =>
		distinctWords(significantWords(title, options.language), sameWord),
	);
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

/** Whether two words are one word in different forms: one starts the other and is long enough to mean it. */
export function sameStem(a: string, b: string): boolean {
	if (a === b) return true;
	const [short, long] = [...a].length <= [...b].length ? [a, b] : [b, a];
	return [...short].length >= MIN_STEM && long.startsWith(short);
}

/**
 * Whether a search text finds `haystack`, for the filters of read tools (never for deciding which
 * item a change names: that is `matchThing`, which stays strict). The text is found when it is
 * contained as written, or when each of its words is a word of the haystack or a form of one:
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
