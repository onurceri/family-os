import {
	distinctWords,
	lowerIn,
	namedShares,
	sameStemIn,
	sameWordIn,
	significantWords,
	type WordOptions,
} from './label-words.ts';

/*
 * One answer to "are these words that thing?", for every place that decides it: a duplicate
 * warning, an offer to change the event that is there instead, the thing a change, a tick or a
 * cancellation is about, and the check that an AI's label names its target. `exact` and `strong`
 * are acted on. A `weak` match is acted on only when it is the one thing named, by the same words
 * in another form ("swim lessons" for "Swim lesson"), and then marked for a person to check
 * (`targetOf`); every other `weak` one is told to the person as a question ("which one?").
 */

/**
 * How surely words name a thing:
 * - `exact`: the same words and the same codes, order, case and accents aside;
 * - `strong`: one side's words are all whole words of the other ("Milk" and "Oat milk"), with no
 *   code or number that disagrees;
 * - `weak`: something points at it, but not surely: most of its words, the same words in other
 *   forms ("Dentist checkups"), or several things that fit equally well;
 * - `none`: the words do not name it, or a code or a number says it is another one.
 */
export type MatchBand = 'exact' | 'strong' | 'weak' | 'none';

/**
 * Why a match is in its band:
 * - `same`: the same words and codes;
 * - `within`: the words of one side are all words of the other;
 * - `forms`: the same words, some of them in another form;
 * - `partial`: more than half of the thing's words, not all;
 * - `several`: more than one thing fits equally well;
 * - `codes`: a code or a number differs ("1B" and "3B", "10" and "18", two plates);
 * - `elsewhere`: the shared message names another thing more, or does not name this one;
 * - `unnamed`: the words do not name it.
 */
export type MatchReason =
	| 'same'
	| 'within'
	| 'forms'
	| 'partial'
	| 'several'
	| 'codes'
	| 'elsewhere'
	| 'unnamed';

/** How words name one title. */
export interface ThingComparison {
	band: MatchBand;
	reason: MatchReason;
}

/** Which of some candidates words name, and how surely. */
export interface ThingMatch<T> {
	band: MatchBand;
	reason: MatchReason;
	/** The thing meant: set for `exact` and `strong`, and for `weak` the likeliest one. */
	candidate: T | null;
	/**
	 * For `weak`, the things it may be, likeliest first (for "which one?"); else the candidate
	 * alone, or nothing.
	 */
	candidates: readonly T[];
	/**
	 * For `several`, how surely the words name each of them: `exact` or `strong` when the things
	 * tie as equally good names (a day may tell them apart), `weak` when each is only a guess.
	 */
	each?: MatchBand;
}

export interface MatchOptions extends WordOptions {
	/**
	 * The whole shared message. The thing chosen must be one it names, and the one it names most:
	 * words that fit one thing while the message is about another point at nothing.
	 */
	text?: string | null;
}

/** A partly named thing is a guess only when more than this share of its words is named. */
const MIN_SHARE = 0.5;

/**
 * One code written in parts, as a person writes it: a number with a letter or two glued by a dot
 * or a dash ("8.b", "u-13", "3.A"), or numbers with short letter groups between them ("34 ABC
 * 123", a plate; "29.10"), or a number and one letter ("1 B"). It starts at a number standing
 * alone, so a word next to a number ("on 12") never joins it.
 */
const CODE_PARTS =
	/(?<![\p{L}\p{N}])(?:\p{L}{1,2}[.-])?\p{N}+(?:(?:[ .-]\p{L}{1,3})?[ .-]\p{N}+)*(?:[.-]\p{L}{1,2}| \p{L})?(?![\p{L}\p{N}])/gu;

/**
 * A text as it is compared: anything in brackets left out (a date, a note), and each code written
 * in parts joined into one token, so "34 ABC 123" and "34ABC123" are one plate.
 */
const compared = (text: string) =>
	text
		.replace(/\([^)]*\)|\[[^\]]*\]/gu, ' ')
		.replace(CODE_PARTS, (code) => code.replace(/[ .-]/gu, ''));

/**
 * The codes and numbers of a compared text: every token with a digit in it ("1b", "u13", "10",
 * "34abc123"). They tell things apart in any language: "Class 1B trip" is not "Class 3B trip",
 * and "Pay 10 EUR" is not "Pay 18 EUR".
 */
function codesOf(text: string, language: string | undefined): string[] {
	const tokens = lowerIn(text, language).match(/[\p{L}\p{N}]+/gu) ?? [];
	return [...new Set(tokens.filter((t) => /\p{N}/u.test(t)))];
}

type Agreement = 'equal' | 'within' | 'differ';

/**
 * Whether two sides' codes agree: `equal` when they are the same (or neither has one), `within`
 * when one side's are all the other's (or only one side has any), else `differ`.
 */
function agreement(
	a: readonly string[],
	b: readonly string[],
	same: (x: string, y: string) => boolean,
): Agreement {
	const inside = (x: readonly string[], y: readonly string[]) =>
		x.every((c) => y.some((d) => same(c, d)));
	if (inside(a, b) && inside(b, a)) return 'equal';
	if (a.length === 0 || b.length === 0 || inside(a, b) || inside(b, a)) return 'within';
	return 'differ';
}

const RANK: Record<MatchBand, number> = { exact: 3, strong: 2, weak: 1, none: 0 };

/**
 * How words name one title, given the share of the title they name (`namedShares`, weighted
 * among the titles compared).
 */
function compare(words: string, title: string, share: number, language?: string): ThingComparison {
	const same = sameWordIn(language);
	const [said, named] = [compared(words), compared(title)];
	const wanted = distinctWords(significantWords(said, language), same);
	const have = distinctWords(significantWords(named, language), same);
	if (wanted.length === 0 || have.length === 0) {
		// Without a word that tells things apart ("4"), only the same text names it.
		const plain = (s: string) => s.trim().replace(/\s+/gu, ' ');
		const a = plain(words);
		const b = plain(title);
		return a !== '' && b !== '' && same(a, b)
			? { band: 'exact', reason: 'same' }
			: { band: 'none', reason: 'unnamed' };
	}
	const codes = agreement(codesOf(said, language), codesOf(named, language), same);
	if (codes === 'differ') return { band: 'none', reason: 'codes' };
	const within = (a: readonly string[], b: readonly string[], eq: typeof same) =>
		a.every((w) => b.some((h) => eq(w, h)));
	const words1 = within(wanted, have, same);
	const words2 = within(have, wanted, same);
	if (words1 && words2 && codes === 'equal') return { band: 'exact', reason: 'same' };
	if (words1 || words2) return { band: 'strong', reason: 'within' };
	const form = sameStemIn(language);
	if (within(wanted, have, form) || within(have, wanted, form))
		return { band: 'weak', reason: 'forms' };
	if (share > MIN_SHARE) return { band: 'weak', reason: 'partial' };
	return { band: 'none', reason: 'unnamed' };
}

/**
 * How surely `words` name the thing titled `title`, on its own (a duplicate check, the check
 * that a label names its target). Order, case and accents do not matter; whole words do.
 */
export function compareThing(
	words: string,
	title: string,
	options: WordOptions = {},
): ThingComparison {
	const [share = 0] = namedShares(words, [title], options);
	return compare(words, title, share, options.language);
}

/** Whether words surely name the thing titled `title`: `exact` or `strong`. */
export function namesThing(words: string, title: string, options: WordOptions = {}): boolean {
	return RANK[compareThing(words, title, options).band] >= RANK.strong;
}

/**
 * Whether the person's own words (`label`) name the thing titled `title`.
 * @deprecated Use `matchThing`, or `namesThing` for one title: this is `namesThing`.
 */
export function labelNamesTitle(label: string, title: string): boolean {
	return namesThing(label, title);
}

/**
 * What may be done with a match: `sure` (an `exact` or `strong` one), `marked` (a lone `weak`
 * one by other forms of the same words, acted on with the target shown as "check this": people
 * say "the swim lessons" for "Swim lesson" all the time, and refusing it would lose what they
 * asked for), or null (ask which one, or nothing is named).
 */
export function targetOf(match: Pick<ThingMatch<unknown>, 'band' | 'reason' | 'candidates'>) {
	if (match.band === 'exact' || match.band === 'strong') return 'sure' as const;
	if (match.band === 'weak' && match.reason === 'forms' && match.candidates.length === 1)
		return 'marked' as const;
	return null;
}

/**
 * Which of some candidates `words` name, and how surely. Each candidate is compared as
 * `compareThing` does, and the best band wins; within it, the one the words name most (the
 * share of its words they say, rare words counting more, then the share of the words it holds:
 * "the oat milk" names all of "Milk" and "Oat milk", but "Oat milk" holds more of it). Several
 * equally good are `weak` with the reason `several`. With `text`, the choice must also be the
 * thing the message names, and the one it names most (else `none`, reason `elsewhere`); between
 * equally good ones, the one the message names most is taken.
 */
export function matchThing<T extends { label: string }>(
	words: string | undefined,
	candidates: readonly T[],
	options: MatchOptions = {},
): ThingMatch<T> {
	const nothing = (reason: MatchReason): ThingMatch<T> => ({
		band: 'none',
		reason,
		candidate: null,
		candidates: [],
	});
	const wanted = words?.trim() ?? '';
	if (wanted === '' || candidates.length === 0) return nothing('unnamed');
	const { language } = options;
	const labels = candidates.map((c) => c.label);
	const shares = namedShares(wanted, labels, options);
	const scored = candidates.map((candidate, i) => {
		const share = shares[i] ?? 0;
		const back = namedShares(candidate.label, [wanted], options)[0] ?? 0;
		return {
			candidate,
			i,
			...compare(wanted, candidate.label, share, language),
			score: share + back,
		};
	});
	const top = Math.max(...scored.map((s) => RANK[s.band]));
	if (top === RANK.none)
		return nothing(scored.some((s) => s.reason === 'codes') ? 'codes' : 'unnamed');
	let inBand = scored
		.filter((s) => RANK[s.band] === top)
		.toSorted((a, b) => b.score - a.score || a.i - b.i);

	const text = options.text?.trim();
	const inText = text ? namedShares(text, labels, options) : [];
	const textShare = (s: { i: number }) => inText[s.i] ?? 0;
	// The message names it, and names nothing else more.
	const told = (s: { i: number }) =>
		textShare(s) > 0 && !scored.some((o) => o.i !== s.i && textShare(o) > textShare(s));

	if (top === RANK.weak) {
		if (text) inBand = inBand.filter(told);
		const [first] = inBand;
		if (!first) return nothing('elsewhere');
		return {
			band: 'weak',
			reason: inBand.length > 1 ? 'several' : first.reason,
			candidate: first.candidate,
			candidates: inBand.map((s) => s.candidate),
			...(inBand.length > 1 && { each: 'weak' as const }),
		};
	}

	const best = inBand[0]?.score ?? 0;
	let tied = inBand.filter((s) => s.score === best);
	if (tied.length > 1 && text) {
		const most = Math.max(...tied.map(textShare));
		const named = most > 0 ? tied.filter((s) => textShare(s) === most) : [];
		if (named.length === 1) tied = named;
	}
	const [chosen] = tied;
	if (!chosen) return nothing('unnamed');
	if (tied.length > 1)
		return {
			band: 'weak',
			reason: 'several',
			candidate: chosen.candidate,
			candidates: tied.map((s) => s.candidate),
			each: chosen.band,
		};
	if (text && !told(chosen)) return nothing('elsewhere');
	return {
		band: chosen.band,
		reason: chosen.reason,
		candidate: chosen.candidate,
		candidates: [chosen.candidate],
	};
}
