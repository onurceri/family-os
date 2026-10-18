import { epochOf } from '@famos/time';
import type { AwaitedChange } from '@famos/ui/app';
import { describe, expect, it } from 'vitest';
import { onDay } from '../src/web/board.ts';
import {
	isWaiting,
	waitingDetail,
	waitingOccurrence,
	waitingOccurrences,
} from '../src/web/waiting.ts';

// A new event someone asked for that waits for approval is drawn on the calendar as a ghost.
const TZ = 'Europe/Istanbul';
const change = (input: object, over: Partial<AwaitedChange> = {}): AwaitedChange => ({
	draftId: 'draft_1',
	actionId: 'calendar.createEvent',
	input,
	before: null,
	...over,
});

describe('a waiting new event as an occurrence', () => {
	it('sits on its day at its time, and is not a saved event', () => {
		const o = waitingOccurrence(
			change({ title: 'Swim', date: '2026-10-20', startTime: '16:00', endTime: '17:30' }),
			TZ,
		);
		expect(o).not.toBeNull();
		if (!o) return;
		expect(isWaiting(o)).toBe(true);
		expect(o.eventId).toBe('waiting:draft_1');
		expect(o.start).toBe(epochOf('2026-10-20', '16:00', TZ));
		expect(o.end).toBe(epochOf('2026-10-20', '17:30', TZ));
		expect(onDay(o, '2026-10-20', TZ)).toBe(true);
		expect(onDay(o, '2026-10-21', TZ)).toBe(false);
	});

	it('lasts an hour when no end is given, and ends the next day when it ends earlier', () => {
		const hour = waitingOccurrence(
			change({ title: 'A', date: '2026-10-20', startTime: '10:00' }),
			TZ,
		);
		expect((hour?.end ?? 0) - (hour?.start ?? 0)).toBe(3_600_000);
		const night = waitingOccurrence(
			change({ title: 'B', date: '2026-10-20', startTime: '22:00', endTime: '01:00' }),
			TZ,
		);
		expect(night && onDay(night, '2026-10-21', TZ)).toBe(true);
	});

	it('covers the days of an all-day event', () => {
		const o = waitingOccurrence(
			change({ title: 'Trip', allDay: true, date: '2026-10-20', endDate: '2026-10-22' }),
			TZ,
		);
		expect(o).toMatchObject({ allDay: true, startDate: '2026-10-20', endDate: '2026-10-22' });
		expect(o && onDay(o, '2026-10-22', TZ)).toBe(true);
	});

	it('keeps the people and tags it was asked with', () => {
		const o = waitingOccurrence(
			change({
				title: 'Swim',
				date: '2026-10-20',
				startTime: '16:00',
				memberIds: ['member_01927c2e-7b1a-7000-8000-000000000001'],
				tags: ['sport'],
			}),
			TZ,
		);
		expect(o).toMatchObject({
			memberIds: ['member_01927c2e-7b1a-7000-8000-000000000001'],
			tags: ['sport'],
		});
	});

	it('is read as details, with what it would be', () => {
		const o = waitingOccurrence(
			change({ title: 'Swim', date: '2026-10-20', startTime: '16:00', location: 'Pool' }),
			TZ,
		);
		expect(o && waitingDetail(o)).toMatchObject({
			title: 'Swim',
			date: '2026-10-20',
			startTime: '16:00',
			location: 'Pool',
		});
	});

	it('leaves out other changes and inputs that do not fit', () => {
		expect(
			waitingOccurrences(
				[
					change({ title: 'Swim', date: '2026-10-20', startTime: '16:00' }),
					change({ id: 'evt_1', title: 'Swim' }, { actionId: 'calendar.changeEvent' }),
					change({ title: '', date: 'tomorrow' }),
				],
				TZ,
			),
		).toHaveLength(1);
	});

	it('is not waiting for a saved occurrence', () => {
		expect(
			isWaiting({
				eventId: 'evt_1',
				key: 'k',
				title: 'x',
				allDay: true,
				start: null,
				end: null,
				startDate: '2026-10-20',
				endDate: '2026-10-20',
				memberIds: [],
				location: null,
				recurring: false,
				notes: null,
				source: null,
				editable: true,
				tags: [],
			}),
		).toBe(false);
	});
});
