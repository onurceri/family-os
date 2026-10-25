import { type DuplicateContext, FamosError } from '@famos/sdk';
import { addDays, daysBetween, isValidDate, zoned } from '@famos/time';
import type { EventDetail } from '../contract/index.ts';
import { type EventRow, events, expandRow } from './store.ts';

/**
 * One date of a repeating event as an event of its own: the series' details at that date (a
 * multi-day all-day event keeps its length, a timed one its start and end). Throws when the key
 * is not one of the series' dates.
 */
export function occurrenceDetail(row: EventRow, series: EventDetail, key: string): EventDetail {
	const notThere = () => new FamosError('bad_request', 'That is not one of the event’s dates');
	const day = row.all_day
		? key
		: Number.isFinite(Number(key))
			? zoned(Number(key), row.time_zone).toPlainDate().toString()
			: '';
	if (!day || !isValidDate(day)) throw notThere();
	if (!expandRow(row, day, day, row.time_zone).some((o) => o.key === key)) throw notThere();
	if (row.all_day) {
		const span = daysBetween(series.date, series.endDate ?? series.date);
		return {
			...series,
			date: key,
			endDate: span > 0 ? addDays(key, span) : null,
			recurrence: null,
			rrule: null,
		};
	}
	const hhmm = (ms: number) => zoned(ms, row.time_zone).toPlainTime().toString().slice(0, 5);
	const start = Number(key);
	return {
		...series,
		date: day,
		startTime: hhmm(start),
		endTime: hhmm(start + ((row.ends_at as number) - (row.starts_at as number))),
		recurrence: null,
		rrule: null,
	};
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** An instant as an app writes it (RFC 3339, with an offset): a `+` in an address may arrive as a space. */
const INSTANT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+\- ]\d{2}:\d{2})$/;

/** The key of a timed event's occurrence an RFC 3339 instant names; anything else as it is. */
function instantKey(row: Pick<EventRow, 'all_day'>, key: string): string {
	if (row.all_day || !INSTANT_KEY.test(key)) return key;
	const ms = Date.parse(key.replace(/ (\d{2}:\d{2})$/, '+$1'));
	return Number.isFinite(ms) ? String(ms) : key;
}

/**
 * The occurrence key of one date of a repeating event. A timed series is keyed by the start
 * (epoch milliseconds), but a model or a person names the date, so a date maps to the one
 * occurrence on that day. Throws a `bad_request` that says what to send instead.
 */
export function occurrenceKey(row: EventRow, given: string): string {
	const key = instantKey(row, given);
	const keys = (day: string) => expandRow(row, day, day, row.time_zone).map((o) => o.key);
	if (!row.all_day && DATE_KEY.test(key)) {
		const found = isValidDate(key) ? keys(key) : [];
		if (found.length === 0)
			throw new FamosError(
				'bad_request',
				`This repeating event does not happen on ${key}. Use the \`occurrence\` that calendar.findEvents shows for the date you mean.`,
			);
		if (found.length > 1)
			throw new FamosError(
				'bad_request',
				`This repeating event happens more than once on ${key}. Use the \`occurrence\` that calendar.findEvents shows for the one you mean.`,
			);
		return String(found[0]);
	}
	const day = row.all_day
		? key
		: Number.isFinite(Number(key))
			? zoned(Number(key), row.time_zone).toPlainDate().toString()
			: '';
	if (!day || !isValidDate(day) || !keys(day).includes(key))
		throw new FamosError(
			'bad_request',
			`'${key}' is not one of the event’s dates. Use the \`occurrence\` that calendar.findEvents shows, or the date of that occurrence.`,
		);
	return key;
}

/** `resolveNames` of the actions that take an `occurrence`: stores the key, never a date. */
export const resolveOccurrence = async <T extends { id: string; occurrence?: string | undefined }>(
	ctx: DuplicateContext,
	input: T,
): Promise<T> => {
	if (!input.occurrence) return input;
	const row = await events(ctx.db)
		.selectFrom('calendar_events')
		.selectAll()
		.where('id', '=', input.id)
		.where('deleted_at', 'is', null)
		.executeTakeFirst();
	// A missing event or a single event is the action's own business.
	if (!row?.rrule) return input;
	return { ...input, occurrence: occurrenceKey(row, input.occurrence) };
};

/** `scopeNote` of the actions that take an `occurrence`: the one date a change is limited to. */
export const occurrenceScope = async (
	ctx: DuplicateContext,
	input: { id: string; occurrence?: string | undefined },
): Promise<{ key: string; date: string } | null> => {
	if (!input.occurrence) return null;
	const row = await events(ctx.db)
		.selectFrom('calendar_events')
		.selectAll()
		.where('id', '=', input.id)
		.where('deleted_at', 'is', null)
		.executeTakeFirst();
	// On a single event the occurrence means nothing: the change is to the whole of it.
	if (!row?.rrule) return null;
	const date = DATE_KEY.test(input.occurrence)
		? input.occurrence
		: row.all_day
			? input.occurrence
			: Number.isFinite(Number(input.occurrence))
				? zoned(Number(input.occurrence), row.time_zone).toPlainDate().toString()
				: '';
	return isValidDate(date) ? { key: 'calendar:title_one_date', date } : null;
};
