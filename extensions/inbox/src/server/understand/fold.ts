import type { IndexedMention, Mention } from '@famos/sdk';

/*
 * Details that belong to another mention of the same reading (`detailOf`): a thing to bring to an
 * event, a rule for it, a fee for it. The model only says whose detail it is; code decides where
 * it goes. A detail goes into its mention's notes when that mention's kind takes notes, and stays
 * a suggestion of its own when it has a day or a person of its own (a fee due on Friday is a task
 * to do by then, whoever's event it is for).
 */

/** Folded notes grow to at most this many characters; a detail past it stays on its own. */
export const FOLDED_NOTES_MAX = 1000;

/** The mentions of a reading after its details were folded into the mentions they belong to. */
export interface Folded {
	/** The mentions to resolve: every one but the folded details, which their mentions now carry. */
	mentions: IndexedMention[];
	/** For each mention (by its index) that took details: the details, as they were read. */
	details: Map<number, IndexedMention[]>;
}

/** Whether a detail says when or for whom on its own, so it is a thing of its own to do. */
const standsAlone = (m: Mention) =>
	m.date !== undefined ||
	m.endDate !== undefined ||
	m.repeat !== undefined ||
	(m.people?.length ?? 0) > 0 ||
	m.forMe === true;

const lower = (text: string, locale: string) =>
	text.toLocaleLowerCase(locale).replace(/\s+/gu, ' ').trim();

/**
 * A detail written as one line of notes: its title (or the thing it names), then whatever else it
 * holds that the title does not already say (an amount, a time, a place, its own notes, its
 * lines). Null when it holds no words.
 */
export function detailLine(m: Mention, locale: string): string | null {
	const parts: string[] = [];
	for (const part of [
		m.title ?? m.target,
		m.amount,
		m.timeText ?? m.time,
		m.place,
		m.notes,
		m.lines?.join(', '),
	]) {
		const text = part?.replace(/\s+/gu, ' ').trim();
		if (!text) continue;
		if (parts.some((p) => lower(p, locale).includes(lower(text, locale)))) continue;
		parts.push(text);
	}
	return parts.length > 0 ? parts.join(', ') : null;
}

/** Notes with a line added, unless they say it already. Lines keep apart in any language. */
function withLine(notes: string | undefined, line: string, locale: string): string {
	const before = notes?.trim() ?? '';
	if (before === '') return line;
	if (lower(before, locale).includes(lower(line, locale))) return before;
	return `${before}\n${line}`;
}

/**
 * Folds each detail into the notes of the mention it names with `detailOf` (an index of the reading),
 * when that mention is here, is not a detail folded itself, and has a kind that takes notes
 * (`takesNotes`), and when the detail has no day and no person of its own. Every other mention,
 * a detail that cannot be folded included, is resolved as it was read.
 */
export function foldDetails(
	mentions: readonly IndexedMention[],
	takesNotes: (kind: string) => boolean,
	locale: string,
): Folded {
	const byIndex = new Map(mentions.map((m) => [m.index, m]));
	const foldable = (m: IndexedMention): IndexedMention | null => {
		const of = m.mention.detailOf;
		if (of === undefined || of === m.index || standsAlone(m.mention)) return null;
		const parent = byIndex.get(of);
		if (!parent || !takesNotes(parent.mention.kind)) return null;
		return detailLine(m.mention, locale) === null ? null : parent;
	};
	// A detail of a detail has nowhere sure to go: only details of mentions that stay are folded.
	const parents = new Map<number, IndexedMention>();
	for (const m of mentions) {
		const parent = foldable(m);
		if (parent) parents.set(m.index, parent);
	}
	for (const [child, parent] of [...parents]) if (parents.has(parent.index)) parents.delete(child);

	const notes = new Map<number, string | undefined>();
	const details = new Map<number, IndexedMention[]>();
	const folded = new Set<number>();
	for (const m of mentions) {
		const parent = parents.get(m.index);
		if (!parent) continue;
		const before = notes.has(parent.index) ? notes.get(parent.index) : parent.mention.notes;
		const after = withLine(before, detailLine(m.mention, locale) as string, locale);
		if ([...after].length > FOLDED_NOTES_MAX) continue;
		notes.set(parent.index, after);
		details.set(parent.index, [...(details.get(parent.index) ?? []), m]);
		folded.add(m.index);
	}
	return {
		mentions: mentions
			.filter((m) => !folded.has(m.index))
			.map((m) => {
				const own = notes.get(m.index);
				return own === undefined ? m : { index: m.index, mention: { ...m.mention, notes: own } };
			}),
		details,
	};
}

/**
 * Whether a suggestion's input still holds a detail folded into it: its line is in one of the
 * input's texts. A resolver may turn a mention into something that keeps no notes (a new event
 * that is a move of one already there); then the detail has to be read on its own.
 */
export function keepsDetail(input: unknown, detail: Mention, locale: string): boolean {
	const line = detailLine(detail, locale);
	if (line === null) return false;
	const wanted = lower(line, locale);
	const texts: string[] = [];
	const walk = (value: unknown) => {
		if (typeof value === 'string') texts.push(value);
		else if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === 'object') Object.values(value).forEach(walk);
	};
	walk(input);
	return texts.some((text) => lower(text, locale).includes(wanted));
}
