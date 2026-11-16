import { describe, expect, it } from 'vitest';
import { type AgendaItem, slideshowPlan } from '../src/web/agenda.js';

const timeZone = 'UTC';
const utc = { timeZone, dateLocale: 'en-GB', hourCycle: 'h23' } as const;
const at = (hhmm: string, day = '2026-10-11') => Date.parse(`${day}T${hhmm}:00Z`);
const now = at('16:00');

const timed = (id: string, start: number, end: number | null = null): AgendaItem => ({
	id,
	title: id,
	allDay: false,
	start,
	end,
	startDate: null,
	endDate: null,
});
const allDay = (id: string, startDate: string, endDate: string | null = null): AgendaItem => ({
	id,
	title: id,
	allDay: true,
	start: null,
	end: null,
	startDate,
	endDate,
});

describe('slideshowPlan: today from now', () => {
	it('lists what is left of today with the start written the family way', () => {
		const items = [
			timed('Breakfast', at('08:00'), at('09:00')),
			timed('Piano', at('16:30'), at('17:30')),
			timed('Dinner', at('19:05'), at('20:00')),
		];
		const plan = slideshowPlan(items, now, utc);
		expect(plan.when).toBe('today');
		expect(plan.events.map((e) => [e.id, e.time])).toEqual([
			['Piano', '16:30'],
			['Dinner', '19:05'],
		]);
		expect(plan.nextId).toBe('Piano');
	});

	it('writes times on a 12-hour clock when the family uses one', () => {
		const plan = slideshowPlan([timed('Piano', at('16:30'), at('17:00'))], now, {
			...utc,
			dateLocale: 'en-US',
			hourCycle: 'h12',
		});
		expect(plan.events.map((e) => e.time.replace(/\s/g, ' '))).toEqual(['4:30 PM']);
	});

	it('keeps an event that is running until it ends, but marks the one still to start', () => {
		const items = [
			timed('Swimming', at('15:00'), at('17:30')),
			timed('Dinner', at('18:30'), at('19:30')),
			timed('Over', at('14:00'), at('15:59')),
		];
		const plan = slideshowPlan(items, now, utc);
		expect(plan.events.map((e) => e.id)).toEqual(['Swimming', 'Dinner']);
		expect(plan.nextId).toBe('Dinner');
		expect(slideshowPlan(items, at('17:30'), utc).events.map((e) => e.id)).toEqual(['Dinner']);
	});

	it('marks nothing when only running events are left', () => {
		const plan = slideshowPlan([timed('Swimming', at('15:00'), at('17:30'))], now, utc);
		expect(plan.events).toHaveLength(1);
		expect(plan.nextId).toBeNull();
	});

	it('keeps an event without an end for 15 minutes after it starts, as before', () => {
		const items = [timed('Call', at('15:50')), timed('Old', at('15:40'))];
		expect(slideshowPlan(items, now, utc).events.map((e) => e.id)).toEqual(['Call']);
	});

	it('uses the family time zone for the day and the times', () => {
		const tokyo = { ...utc, timeZone: 'Asia/Tokyo' };
		// 16:00 UTC is 01:00 on the 12th in Tokyo; an event at 02:00 there is still today.
		const plan = slideshowPlan([timed('Early', at('17:00'), at('18:00'))], now, tokyo);
		expect(plan.when).toBe('today');
		expect(plan.events[0]?.time).toBe('02:00');
	});

	it('has all-day events of today as one line of titles, and not those of other days', () => {
		const items = [
			allDay('Holiday', '2026-10-10', '2026-10-12'),
			allDay('Birthday', '2026-10-11'),
			allDay('Tomorrow only', '2026-10-12'),
			allDay('Yesterday', '2026-10-09', '2026-10-10'),
			timed('Piano', at('16:30'), at('17:00')),
		];
		expect(slideshowPlan(items, now, utc).allDay).toEqual(['Holiday', 'Birthday']);
	});

	it('hands over every event left, so the caller can count "more"', () => {
		const items = Array.from({ length: 8 }, (_, i) =>
			timed(`e${i}`, at(`${17 + (i % 6)}:${i < 6 ? '00' : '30'}`), at('23:00')),
		);
		expect(slideshowPlan(items, now, utc).events).toHaveLength(8);
	});
});

describe('slideshowPlan: tomorrow and nothing', () => {
	it('shows the first events of tomorrow once today is finished, none marked', () => {
		const items = [
			timed('Done', at('09:00'), at('10:00')),
			allDay('Holiday', '2026-10-11'),
			timed('School run', at('08:15', '2026-10-12'), at('08:45', '2026-10-12')),
			timed('Dentist', at('10:00', '2026-10-12'), at('11:00', '2026-10-12')),
			timed('Much later', at('09:00', '2026-10-13')),
		];
		const plan = slideshowPlan(items, now, utc);
		expect(plan.when).toBe('tomorrow');
		expect(plan.events.map((e) => e.id)).toEqual(['School run', 'Dentist']);
		expect(plan.nextId).toBeNull();
		expect(plan.allDay).toEqual([]);
	});

	it('is empty when nothing timed is ahead today or tomorrow', () => {
		const items = [timed('Done', at('09:00'), at('10:00')), allDay('Holiday', '2026-10-11')];
		expect(slideshowPlan(items, now, utc)).toEqual({
			when: 'none',
			allDay: [],
			events: [],
			nextId: null,
		});
		expect(slideshowPlan([], now, utc).when).toBe('none');
	});

	it('rolls over at midnight in the family time zone', () => {
		const items = [
			timed('Late', at('22:00'), at('23:00')),
			timed('Early', at('07:00', '2026-10-12')),
		];
		expect(slideshowPlan(items, at('21:00'), utc).when).toBe('today');
		const after = slideshowPlan(items, at('00:05', '2026-10-12'), utc);
		expect(after.when).toBe('today');
		expect(after.events.map((e) => e.id)).toEqual(['Early']);
	});
});
