import { addDays, epochOf, Temporal } from '@famos/time';
import type { DayItem, TimelineItem, TodayReport } from '@famos/ui/slots';
import { groupOf, sortTimeline } from '@famos/ui/timeline';

/** Composition rules of the Today page, without Svelte. */

export type PartOfDay = 'morning' | 'afternoon' | 'evening';

/** The hour of an instant in the family's time zone (0 to 23). */
export const hourIn = (at: number, timeZone: string): number =>
	Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(timeZone).hour;

export function partOfDay(now: number, timeZone: string): PartOfDay {
	const hour = hourIn(now, timeZone);
	return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

/** Merges what the timeline contributions return for one day, in the order of the day. */
export const mergeTimeline = (lists: readonly (readonly TimelineItem[])[]): TimelineItem[] =>
	sortTimeline(lists.flat());

/**
 * When the evening starts: the end of the last timed item of the day or 20:00, whichever is
 * later. Meal-plan items (`nominal`) have no clock and never push it.
 */
export function eveningStart(
	items: readonly TimelineItem[],
	day: string,
	timeZone: string,
): number {
	const ends = items
		.filter((i) => groupOf(i) === 1 && !i.nominal)
		.map((i) => i.end ?? i.start ?? 0);
	return Math.max(epochOf(day, '20:00', timeZone), ...ends);
}

export const isEvening = (
	now: number,
	items: readonly TimelineItem[],
	day: string,
	timeZone: string,
): boolean => now >= eveningStart(items, day, timeZone);

/** The last timed item of the day when it starts after 17:00 and is still to come ("… tonight"). */
export function lastTonight(
	items: readonly TimelineItem[],
	now: number,
	timeZone: string,
): TimelineItem | null {
	const timed = items.filter((i) => groupOf(i) === 1 && !i.nominal && i.start !== undefined);
	const last = timed.at(-1);
	return last && (last.start as number) > now && hourIn(last.start as number, timeZone) >= 17
		? last
		: null;
}

export interface SentenceInput {
	part: PartOfDay;
	name: string;
	/** Things waiting on this person. */
	needs: number;
	/** Items on today's timeline. */
	plan: number;
	/** The last timed item after 17:00, if it is still ahead. */
	lastTitle?: string;
	/** Evening mode: tomorrow's first timed item, as a formatted time, or null when it is free. */
	tomorrowStart?: string | null;
	evening?: boolean;
	/** A brand-new family. */
	fresh?: boolean;
	/**
	 * The person hid Needs you from Today: its count is not known here, so the sentence says
	 * nothing about it (never "Nothing needs you").
	 */
	needsHidden?: boolean;
}

/**
 * The day head sentence as one catalog key with its parameters. Each shape is a whole sentence in
 * the catalog (so a language pack words it naturally); only the counts and names are filled in.
 * `**bold**` marks the part that is emphasised.
 */
export function composeSentence(input: SentenceInput): {
	key: string;
	params: Record<string, unknown>;
} {
	const { needs, plan, lastTitle } = input;
	const base = { part: input.part, name: input.name };
	if (input.fresh && needs === 0) return { key: 'home_sentence_new', params: base };
	if (input.evening && needs === 0 && !input.needsHidden)
		return input.tomorrowStart
			? { key: 'home_sentence_evening', params: { ...base, time: input.tomorrowStart } }
			: { key: 'home_sentence_evening_free', params: base };
	const shape = plan > 0 && lastTitle ? '_plan_last' : plan > 0 ? '_plan' : '';
	const params = { ...base, plan, title: lastTitle ?? '' };
	if (input.needsHidden && needs === 0) {
		if (input.evening)
			return input.tomorrowStart
				? { key: 'home_sentence_day_evening', params: { ...base, time: input.tomorrowStart } }
				: { key: 'home_sentence_day_evening_free', params: base };
		if (plan === 0) return { key: 'home_sentence_quiet', params: base };
		return { key: `home_sentence_day${shape}`, params };
	}
	if (needs > 0) return { key: `home_sentence_needs${shape}`, params: { ...params, count: needs } };
	if (plan === 0) return { key: 'home_sentence_quiet', params: base };
	return { key: `home_sentence_clear${shape}`, params };
}

/** Splits `**bold**` marks into runs for rendering (no HTML is ever built from catalog text). */
export function emphasisRuns(text: string): { text: string; bold: boolean }[] {
	return text
		.split('**')
		.map((part, i) => ({ text: part, bold: i % 2 === 1 }))
		.filter((run) => run.text !== '');
}

export interface QuietPhrase {
	key: string;
	count?: number;
}

/**
 * The phrases of the quiet line: one per card that reports nothing (in card order), plus
 * "nothing planned" when the timeline has no items. Cards without a `quietKey` stay silent.
 */
export function quietPhrases(
	cards: readonly { id: string }[],
	reports: Readonly<Record<string, TodayReport | undefined>>,
	options: { planEmpty?: boolean; planKey?: string } = {},
): QuietPhrase[] {
	const phrases: QuietPhrase[] = [];
	if (options.planEmpty && options.planKey) phrases.push({ key: options.planKey });
	for (const card of cards) {
		const report = reports[card.id];
		if (!report || report.count > 0 || !report.quietKey) continue;
		phrases.push({
			key: report.quietKey,
			...(report.quietCount !== undefined && { count: report.quietCount }),
		});
	}
	return phrases;
}

/** The quiet line names at most this many absent things; with more it is "That is all for today." alone. */
export const QUIET_LIST_MAX = 3;

/**
 * The quiet line as one catalog key: a short list of what is not there, or the bare sentence
 * when the list would be longer than `QUIET_LIST_MAX` (six absences are noise, not information).
 * Nothing at all (no phrases, or the page shows the quiet-day hero) gives no line, and neither
 * does something waiting for the person: "That is all" with a tick would read as if all were well.
 */
export function composeQuietLine(
	phrases: readonly string[],
	options: { fresh?: boolean; hero?: boolean; waiting?: boolean } = {},
): { key: string; params: Record<string, unknown> } | null {
	if (phrases.length === 0 || options.hero || options.waiting) return null;
	const suffix = options.fresh ? '_new' : '';
	return phrases.length <= QUIET_LIST_MAX
		? { key: `home_quiet_prefix${suffix}`, params: { list: phrases.join(', ') } }
		: { key: `home_quiet_bare${suffix}`, params: {} };
}

/* ───────────── a light day looks ahead ───────────── */

/** A day with fewer timeline items than this is light: it shows the next days after the timeline. */
export const LIGHT_DAY = 3;
/** How many items the look-ahead shows. */
export const NEXT_DAYS_MAX = 4;

export const isLightDay = (plan: number): boolean => plan < LIGHT_DAY;

/**
 * The six days after the day on the timeline: tomorrow onwards by day; in evening mode the
 * timeline already shows tomorrow, so the look-ahead starts the day after.
 */
export function aheadWindow(today: string, evening: boolean): { from: string; to: string } {
	const first = evening ? 2 : 1;
	return { from: addDays(today, first), to: addDays(today, first + 5) };
}

/** The first `max` items of the look-ahead, by day and then in the order of the day. */
export function nextDays(lists: readonly (readonly DayItem[])[], max = NEXT_DAYS_MAX): DayItem[] {
	const byDay = new Map<string, DayItem[]>();
	for (const item of lists.flat()) {
		const list = byDay.get(item.day) ?? [];
		list.push(item);
		byDay.set(item.day, list);
	}
	return [...byDay.keys()]
		.sort()
		.flatMap((day) => sortTimeline(byDay.get(day) ?? []) as DayItem[])
		.slice(0, max);
}

/**
 * Whether the capture box is on the page: for a family that is new, or on a day with nothing on
 * the timeline (the inviting way in), never in the evening. Phones have the Quick add tab.
 */
export const showCaptureBox = (input: {
	canCapture: boolean;
	fresh: boolean;
	plan: number;
	evening: boolean;
}): boolean => input.canCapture && !input.evening && (input.fresh || input.plan === 0);

/** Orders a band's cards: the ones with something urgent first, then by contribution order. */
export function orderCards<T extends { id: string; order?: number }>(
	cards: readonly T[],
	reports: Readonly<Record<string, TodayReport | undefined>>,
): T[] {
	return cards.toSorted(
		(a, b) =>
			(reports[b.id]?.urgent ?? 0) - (reports[a.id]?.urgent ?? 0) ||
			(a.order ?? 0) - (b.order ?? 0),
	);
}

/** "Done: a, b, c" for evening mode; the titles of what was on today's line. */
export const doneTitles = (items: readonly TimelineItem[]): string[] => items.map((i) => i.title);
