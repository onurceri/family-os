import { Temporal } from 'temporal-polyfill';
import { type DayParts, type ResolveDayOptions, resolveDay } from './resolve-day.ts';

/**
 * Which stretch of days a question is about, as a model reads it: a kind and day references,
 * in parts that hold no language. `DayParts` is what `DayRef` of `@famos/sdk` is made of, so a
 * span read by the model fits here as it is.
 */
export interface SpanInput {
	/**
	 * - `day`: one day (`day`);
	 * - `week`: a week, this one unless `day.week` says another ("this week", "next week");
	 * - `weekend`: the coming weekend, or the running one;
	 * - `month`: a month, this one unless `day` names another;
	 * - `next`: the week after this one.
	 * Without a kind, `from` and `to` name a range and `day` a day.
	 */
	kind?: 'day' | 'week' | 'weekend' | 'month' | 'next' | undefined;
	day?: DayParts | undefined;
	from?: DayParts | undefined;
	to?: DayParts | undefined;
}

/**
 * What the answer's header says about the span. The key names the sentence, the dates fill it;
 * the caller turns the dates into the reader's date format.
 * - `today`, `day`: one day;
 * - `this_week`: from today to the week's last day;
 * - `coming_days`: the seven days from today, since no day of this week is left after today;
 * - `next_week`, `weekend`, `month`: that stretch;
 * - `until`: from today until a day;
 * - `range`: between two days.
 */
export type SpanLabelKey =
	| 'today'
	| 'day'
	| 'this_week'
	| 'coming_days'
	| 'next_week'
	| 'weekend'
	| 'month'
	| 'until'
	| 'range';

export interface SpanLabel {
	key: SpanLabelKey;
	/** `YYYY-MM-DD`. */
	from: string;
	/** `YYYY-MM-DD`; the same as `from` for one day. */
	to: string;
}

export interface ResolvedSpan {
	/** `YYYY-MM-DD`, first day, included. */
	from: string;
	/** `YYYY-MM-DD`, last day, included. */
	to: string;
	label: SpanLabel;
}

export interface ResolveSpanOptions {
	/** Order of the family's all-numeric dates, for day references. */
	order?: ResolveDayOptions['order'];
	/** Date words of the installed languages, to check day references against their text. */
	words?: ResolveDayOptions['words'];
	/**
	 * The first and the last day of the weekend (1 = Monday … 7 = Sunday), which regions set
	 * differently. Default Saturday and Sunday.
	 */
	weekend?: readonly [number, number];
}

type PlainDate = Temporal.PlainDate;

const cmp = (a: PlainDate, b: PlainDate) => Temporal.PlainDate.compare(a, b);

/** A day reference that names a week and nothing finer ("this week", "next week"). */
function namesOnlyAWeek(ref: DayParts | undefined): boolean {
	return (
		ref?.week !== undefined &&
		ref.weekday === undefined &&
		ref.day === undefined &&
		ref.month === undefined &&
		ref.inDays === undefined &&
		!ref.numeric
	);
}

/**
 * The days a span names, worked out in code so the same words give the same days every time.
 * `today` is today's date in the family time zone (`YYYY-MM-DD`, so no zone is needed here) and
 * `weekStart` the family's first day of the week (1 = Monday … 7 = Sunday). Null when the span
 * names nothing.
 *
 * The rules:
 * - "this week" runs from today to the week's last day. On the last day itself nothing of the
 *   week is left, so people who ask then mean the coming seven days, today included
 *   (`coming_days`). Only the last day counts: on the day before, the week still has two days and
 *   they are a true answer, with what comes next told by the caller;
 * - "the weekend" is the running one when today falls in it (on its last day, only today), else
 *   the coming one;
 * - "next week" is the week after this one, whole;
 * - a month is the one named, or this one; this one starts today, as everything still to come does;
 * - "until Friday" runs from today to that day, and a range from its first day to its last. A
 *   range that ends before it starts is read the other way round.
 */
export function resolveSpan(
	span: SpanInput,
	today: string,
	weekStart: number,
	options: ResolveSpanOptions = {},
): ResolvedSpan | null {
	const now = Temporal.PlainDate.from(today);
	const dayOptions: ResolveDayOptions = {
		today,
		weekStart,
		...(options.order ? { order: options.order } : {}),
		...(options.words ? { words: options.words } : {}),
	};
	const found = (from: PlainDate, to: PlainDate, key: SpanLabelKey): ResolvedSpan => ({
		from: from.toString(),
		to: to.toString(),
		label: { key, from: from.toString(), to: to.toString() },
	});
	/** A day reference as a first and a last day (a day, or a span such as "next week"). */
	const read = (ref: DayParts | undefined) => {
		const result = resolveDay(ref, dayOptions);
		if (!result) return null;
		return {
			from: Temporal.PlainDate.from(result.date),
			to: Temporal.PlainDate.from(result.to ?? result.date),
		};
	};

	const weekFirst = now.subtract({ days: (now.dayOfWeek - weekStart + 7) % 7 });
	const weekLast = weekFirst.add({ days: 6 });
	const nextFirst = weekFirst.add({ days: 7 });
	const kind =
		span.kind ?? (namesOnlyAWeek(span.day) && !span.from && !span.to ? 'week' : undefined);

	if (kind === 'week') {
		const which = span.day?.week ?? 'this';
		if (which === 'next') return found(nextFirst, nextFirst.add({ days: 6 }), 'next_week');
		if (which === 'after_next')
			return found(nextFirst.add({ days: 7 }), nextFirst.add({ days: 13 }), 'next_week');
		if (now.equals(weekLast)) return found(now, now.add({ days: 6 }), 'coming_days');
		return found(now, weekLast, 'this_week');
	}
	if (kind === 'next') return found(nextFirst, nextFirst.add({ days: 6 }), 'next_week');
	if (kind === 'weekend') {
		const [first, last] = options.weekend ?? [6, 7];
		const length = (last - first + 7) % 7;
		const sinceStart = (now.dayOfWeek - first + 7) % 7;
		return sinceStart <= length
			? found(now, now.subtract({ days: sinceStart }).add({ days: length }), 'weekend')
			: found(
					now.add({ days: 7 - sinceStart }),
					now.add({ days: 7 - sinceStart + length }),
					'weekend',
				);
	}
	if (kind === 'month') {
		const month = span.day ? read(span.day) : null;
		if (month) return found(month.from, month.to, 'month');
		return found(now, now.with({ day: now.daysInMonth }), 'month');
	}

	if (span.from || span.to) {
		const from = read(span.from);
		const to = read(span.to);
		if (from && to) {
			const [a, b] = cmp(from.from, to.to) <= 0 ? [from.from, to.to] : [to.from, from.to];
			return found(a, b, 'range');
		}
		if (to) return cmp(to.to, now) < 0 ? null : found(now, to.to, 'until');
		if (from) return found(from.from, from.to, from.from.equals(from.to) ? 'day' : 'range');
		return null;
	}
	const single = read(span.day);
	if (!single) return null;
	if (!single.from.equals(single.to)) return found(single.from, single.to, 'range');
	return found(single.from, single.to, single.from.equals(now) ? 'today' : 'day');
}
