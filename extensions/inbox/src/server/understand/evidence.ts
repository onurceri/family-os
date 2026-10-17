/*
 * Where in a shared message a reading rests: the model copies the words each mention comes from
 * (`quote`) and the sentences that speak to the machine (`addressed`); code finds them in the
 * message, so what follows is decided on the message's own text, in any language. Models copy
 * nearly but not always exactly (a typo mended, a word left out), so words are matched loosely.
 */

/** A part of the message, as character offsets (`end` exclusive). */
export interface Span {
	start: number;
	end: number;
}

interface Word {
	word: string;
	start: number;
	end: number;
}

/** The letters-and-digits words of a text, lower-cased in the family language, with their places. */
function wordsAt(text: string, locale: string): Word[] {
	return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
		word: m[0].toLocaleLowerCase(locale),
		start: m.index,
		end: m.index + m[0].length,
	}));
}

/** Shortest start two forms of one word share for them to count as one ("gezi", "gezisi"). */
const MIN_STEM = 4;

/** Whether two words are one word as written: equal, one form of the other, or one letter off. */
function sameWord(a: string, b: string): boolean {
	if (a === b) return true;
	const [x, y] = [[...a], [...b]];
	const [short, long] = x.length <= y.length ? [x, y] : [y, x];
	if (short.length >= MIN_STEM && long.slice(0, short.length).join('') === short.join(''))
		return true;
	// A typo mended or made in copying ("tomorow", "tomorrow"; "bottels", "bottles").
	if (short.length < MIN_STEM || long.length - short.length > 1) return false;
	if (short.length === long.length) {
		const off = short.flatMap((ch, i) => (ch === long[i] ? [] : [i]));
		const [i, j] = off;
		if (
			off.length === 2 &&
			i !== undefined &&
			j === i + 1 &&
			short[i] === long[j] &&
			short[j] === long[i]
		)
			return true;
	}
	let i = 0;
	let j = 0;
	let edits = 0;
	while (i < short.length && j < long.length) {
		if (short[i] === long[j]) {
			i++;
			j++;
			continue;
		}
		if (++edits > 1) return false;
		if (short.length === long.length) i++;
		j++;
	}
	return edits + (long.length - j) + (short.length - i) <= 1;
}

/** At least this share of a quote's words must be found, in order, for it to be located. */
const MIN_FOUND = 0.8;

/**
 * Where the message writes the given words: the stretch of its words that holds the most of them
 * in their order (at least `MIN_FOUND`), the shortest such one. Words without letters or digits ("👍") are looked
 * for as written. Null when the message does not write them.
 */
export function locate(words: string, text: string, locale: string): Span | null {
	const wanted = wordsAt(words, locale);
	if (wanted.length === 0) {
		const at = words.trim() === '' ? -1 : text.indexOf(words.trim());
		return at < 0 ? null : { start: at, end: at + words.trim().length };
	}
	const said = wordsAt(text, locale);
	const need = Math.ceil(wanted.length * MIN_FOUND);
	// A stretch that holds enough of the words begins with one of the first few of them.
	const leads = wanted.length - need + 1;
	let best: (Span & { found: number }) | null = null;
	for (let from = 0; from < said.length; from++) {
		const here = (said[from] as Word).word;
		const lead = wanted.slice(0, leads).findIndex((w) => sameWord(w.word, here));
		if (lead < 0) continue;
		// Greedy, in order: each later word of the quote at the next place the message has it,
		// within twice the quote's length.
		let found = 1;
		let at = from + 1;
		let last = from;
		const reach = Math.min(said.length, from + wanted.length * 2);
		for (const w of wanted.slice(lead + 1)) {
			let k = at;
			while (k < reach && !sameWord(w.word, (said[k] as Word).word)) k++;
			if (k < reach) {
				found++;
				last = k;
				at = k + 1;
			}
		}
		if (found < need) continue;
		const span = { start: (said[from] as Word).start, end: (said[last] as Word).end, found };
		const shorter = best !== null && span.end - span.start < best.end - best.start;
		if (!best || found > best.found || (found === best.found && shorter)) best = span;
	}
	return best && { start: best.start, end: best.end };
}

/** Whether two parts of the message overlap. */
export const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

/** How much of the message's words the spans cover, from 0 to 1. */
export function coverage(spans: readonly Span[], text: string, locale: string): number {
	const said = wordsAt(text, locale);
	if (said.length === 0) return 0;
	const inside = said.filter((w) => spans.some((s) => overlaps(s, w)));
	return inside.length / said.length;
}

/** The words of the message a span covers, as the message writes them. */
export const wordsOf = (span: Span, text: string): string => text.slice(span.start, span.end);
