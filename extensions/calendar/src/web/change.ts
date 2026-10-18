import { describeRecurrence, formatClock } from '@famos/time';
import {
	changed,
	type DraftBefore,
	type DraftField,
	draftDate,
	type PresenterContext,
} from '@famos/ui/slots';
import type { EventReplace } from '../contract/index.js';
import { describeWhen } from './format.js';
import { when } from './instead.js';

/** What a `calendar.changeEvent` draft carries. */
export type ChangeEventInput = {
	id: string;
	label?: string;
	title?: string;
	allDay?: boolean;
	date?: string;
	endDate?: string | null;
	startTime?: string;
	endTime?: string | null;
	memberIds?: string[];
	location?: string | null;
	notes?: string | null;
	tags?: string[];
	occurrence?: string;
};

interface When {
	allDay?: boolean;
	date?: string;
	endDate?: string | null;
	startTime?: string | null;
	endTime?: string | null;
}

const WHEN_KEYS = ['allDay', 'date', 'endDate', 'startTime', 'endTime'] as const;

/**
 * When an event is, short ("Sat 7 Nov 07:45"). `timeOnly` leaves the day out, for the new side of
 * a change that keeps the day; `withEnd` adds the end time, when the change sets one.
 */
function whenText(w: When, c: PresenterContext, withEnd: boolean, timeOnly = false): string {
	const t = (key: string) => c.t(`calendar:${key}`);
	if (!w.date) return '';
	if (w.allDay) {
		const last = w.endDate && w.endDate !== w.date ? `–${when(w.endDate, undefined, c)}` : '';
		return `${when(w.date, undefined, c)}${last} · ${t('all_day')}`;
	}
	const clock = (x: string) => formatClock(x, c.dateLocale, c.hourCycle);
	const time = w.startTime
		? `${clock(w.startTime)}${withEnd && w.endTime ? `–${clock(w.endTime)}` : ''}`
		: '';
	if (timeOnly && time) return time;
	return [when(w.date, undefined, c), time].filter(Boolean).join(' ');
}

/** The new "when" alone, as it was always shown when nothing is known of the event as it is. */
function plainWhen(input: ChangeEventInput, c: PresenterContext): string {
	return [
		input.date ? draftDate(input.date, c) : null,
		input.allDay
			? c.t('calendar:all_day')
			: [input.startTime, input.endTime]
					.filter((x): x is string => Boolean(x))
					.map((x) => formatClock(x, c.dateLocale, c.hourCycle))
					.join('–'),
	]
		.filter(Boolean)
		.join(' · ');
}

const text = (v: unknown): string | undefined =>
	v === undefined ? undefined : typeof v === 'string' && v.trim() ? v : '—';

/**
 * The rows of a proposed change to an event: only what changes, each as "old → new" when the
 * event as it is now is known (`before`), so the reviewer sees what it changes from.
 */
export function changeEventFields(
	input: ChangeEventInput,
	c: PresenterContext,
	before: DraftBefore = null,
): DraftField[] {
	const t = (key: string, options?: Record<string, unknown>) => c.t(`calendar:${key}`, options);
	const was = before ?? undefined;
	const fields: DraftField[] = [];
	if (input.title !== undefined && (was !== undefined || input.title !== input.label))
		fields.push({
			label: was === undefined ? t('draft_new_title') : t('field_title'),
			...changed(text(was?.title), input.title),
			path: 'title',
		});
	if (WHEN_KEYS.some((k) => input[k] !== undefined)) {
		const paths = ['date', 'endDate', 'startTime', 'endTime', 'allDay'];
		if (was && typeof was.date === 'string') {
			const old = Object.fromEntries(WHEN_KEYS.map((k) => [k, was[k] ?? undefined])) as When;
			const next: When = { ...old };
			for (const k of WHEN_KEYS) {
				const v = input[k];
				// biome-ignore lint/suspicious/noExplicitAny: each key keeps its own type on both sides.
				if (v !== undefined) (next as any)[k] = v === null ? undefined : v;
			}
			if (next.allDay) next.startTime = next.endTime = undefined;
			const withEnd = input.endTime !== undefined;
			const sameDay = !old.allDay && !next.allDay && old.date === next.date;
			const from = whenText(old, c, withEnd);
			const to = whenText(next, c, withEnd, sameDay);
			fields.push({
				label: t('when'),
				...changed(from === whenText(next, c, withEnd) ? undefined : from, to),
				paths,
			});
		} else fields.push({ label: t('when'), value: plainWhen(input, c), paths });
	}
	if (input.memberIds !== undefined) {
		const names = (ids: readonly string[]) =>
			ids
				.map((id) => c.members.find((m) => m.id === id)?.displayName)
				.filter(Boolean)
				.join(', ') || t('everyone');
		const old = Array.isArray(was?.memberIds) ? names(was.memberIds as string[]) : undefined;
		fields.push({
			label: t('who'),
			...changed(old, names(input.memberIds)),
			path: 'memberIds',
		});
	}
	if (input.location !== undefined)
		fields.push({
			label: t('where'),
			...changed(text(was?.location), text(input.location) as string),
			path: 'location',
		});
	if (input.tags !== undefined) {
		const old = Array.isArray(was?.tags) ? (was.tags as string[]).join(', ') : undefined;
		fields.push({
			label: t('tags'),
			...changed(old === undefined ? undefined : old || '—', input.tags.join(', ') || '—'),
			path: 'tags',
		});
	}
	if (input.notes !== undefined)
		fields.push({
			label: t('notes'),
			...changed(text(was?.notes), text(input.notes) as string),
			path: 'notes',
		});
	return fields;
}

/** What a `calendar.updateEvent` draft carries: the whole event as the form saved it. */
export type UpdateEventInput = { id: string; label?: string; event: EventReplace };

/**
 * The rows of a saved edit of an event: the form sends every field, and `before` holds the ones
 * that differ from the event as it is now, so only those are listed, each as "old → new".
 */
export function updateEventFields(
	input: UpdateEventInput,
	c: PresenterContext,
	before: Record<string, unknown>,
): DraftField[] {
	const t = (key: string) => c.t(`calendar:${key}`);
	const { event } = input;
	const values: Record<string, unknown> = {
		title: event.title,
		allDay: event.allDay ?? false,
		date: event.date,
		endDate: event.endDate ?? null,
		startTime: event.startTime ?? null,
		endTime: event.endTime ?? null,
		memberIds: event.memberIds ?? [],
		location: event.location ?? null,
		notes: event.notes ?? null,
		tags: event.tags ?? [],
	};
	const change = Object.fromEntries(
		Object.keys(before)
			.filter((k) => k in values)
			.map((k) => [k, values[k]]),
	);
	const fields = changeEventFields({ id: input.id, ...change }, c, before);
	if ('recurrence' in before) {
		// A weekly repeat on the day it starts reads "Every Thursday": the day is named once.
		const repeat = (r: unknown, startDate: string | undefined) =>
			r && typeof r === 'object'
				? describeRecurrence(
						{ interval: 1, ...r } as Parameters<typeof describeRecurrence>[0],
						t,
						c.dateLocale,
						c.weekStart,
						startDate,
					)
				: t('repeat_none');
		const was = typeof before.date === 'string' ? before.date : event.date;
		fields.push({
			label: t('repeat'),
			...changed(repeat(before.recurrence, was), repeat(event.recurrence, event.date)),
			path: 'recurrence',
		});
	}
	// A reminder left at its default is not saved as a choice: only a chosen one is listed.
	if ('reminder' in before && event.reminder !== undefined) {
		const allDay = event.allDay ?? false;
		const reminder = (m: unknown) =>
			typeof m === 'number'
				? t(allDay ? `reminder_all_day_${m}` : `reminder_t_${m}`)
				: t('reminder_none');
		fields.push({
			label: t('reminder'),
			...changed(
				typeof before.reminder === 'number' ? reminder(before.reminder) : undefined,
				reminder(event.reminder),
			),
			path: 'reminder',
		});
	}
	return fields;
}

/** When a removal's event is, from what its waiting draft says the event holds now. */
function removedWhen(
	before: DraftBefore,
): (Parameters<typeof describeWhen>[0] & { recurrence?: unknown }) | null {
	if (!before || typeof before.date !== 'string') return null;
	const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
	return {
		date: before.date,
		allDay: before.allDay === true,
		endDate: text(before.endDate),
		startTime: text(before.startTime),
		endTime: text(before.endTime),
		...(before.recurrence != null && { recurrence: before.recurrence }),
	};
}

/**
 * The lines of a `calendar.deleteEvent` card. While it waits it says when the event (or the one
 * date of a series) that would go is: the removal of a single event and of one date of a series
 * must not read alike. Whether it is that date or the whole series is said for series only.
 */
export function deleteEventFields(
	input: { id: string; occurrence?: string },
	c: PresenterContext,
	before: DraftBefore,
): DraftField[] {
	const t = (key: string) => c.t(`calendar:${key}`);
	const what: DraftField = {
		label: t('draft_what'),
		value: input.occurrence ? t('draft_only_this') : t('draft_whole'),
		path: 'occurrence',
	};
	const at = removedWhen(before);
	if (!at) return [what];
	const fields: DraftField[] = [
		{
			label: t('when'),
			value: describeWhen(at, c.dateLocale, t('all_day'), c.hourCycle, (day) => draftDate(day, c)),
			path: 'occurrence',
		},
	];
	return input.occurrence !== undefined || at.recurrence !== undefined ? [...fields, what] : fields;
}
