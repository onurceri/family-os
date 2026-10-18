import { describe, expect, it } from 'vitest';
import { eventHref, type Occurrence } from '../src/contract/index.ts';
import { eventLink, occurrenceFor } from '../src/web/deep-link.ts';

const ID = 'cal_event_0192a3b4-0000-7000-8000-000000000001';
const OTHER = 'cal_event_0192a3b4-0000-7000-8000-000000000002';

const occurrence = (eventId: string, startDate: string): Occurrence =>
	({
		eventId,
		key: startDate,
		title: 'Piano',
		allDay: true,
		start: null,
		end: null,
		startDate,
		endDate: startDate,
		memberIds: [],
		location: null,
		recurring: true,
		notes: null,
		source: null,
		editable: true,
		tags: [],
	}) as Occurrence;
const covers = (o: Occurrence, day: string) => o.startDate === day;

describe('event links', () => {
	it('reads what eventHref writes', () => {
		const link = eventLink(new URLSearchParams(eventHref(ID, '2026-10-22').split('?')[1]));
		expect(link).toEqual({ eventId: ID, on: '2026-10-22' });
	});

	it('ignores a missing, foreign or invented id', () => {
		expect(eventLink(new URLSearchParams(''))).toBeNull();
		expect(
			eventLink(new URLSearchParams('event=task_0192a3b4-0000-7000-8000-000000000001')),
		).toBeNull();
		expect(eventLink(new URLSearchParams('event=../../x'))).toBeNull();
	});

	it('drops a day that is not a date', () => {
		expect(eventLink(new URLSearchParams(`event=${ID}&on=tomorrow`))).toEqual({
			eventId: ID,
			on: null,
		});
	});

	it('picks the occurrence on the day, else the first of the event, else none', () => {
		const list = [
			occurrence(OTHER, '2026-10-22'),
			occurrence(ID, '2026-10-15'),
			occurrence(ID, '2026-10-22'),
		];
		expect(occurrenceFor(list, { eventId: ID, on: '2026-10-22' }, covers)?.key).toBe('2026-10-22');
		expect(occurrenceFor(list, { eventId: ID, on: '2026-10-29' }, covers)?.key).toBe('2026-10-15');
		expect(occurrenceFor(list, { eventId: ID, on: null }, covers)?.key).toBe('2026-10-15');
		expect(
			occurrenceFor([occurrence(OTHER, '2026-10-22')], { eventId: ID, on: null }, covers),
		).toBeNull();
	});
});
