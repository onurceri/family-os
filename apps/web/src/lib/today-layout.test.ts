import type { DayItem } from '@famos/ui/slots';
import { describe, expect, it } from 'vitest';
import { aheadWindow, composeQuietLine, isLightDay, nextDays, showCaptureBox } from './today.js';

/** The composition of a sparse day. */

describe('the quiet line', () => {
	it('names up to three absent things, and is bare beyond that', () => {
		expect(composeQuietLine(['no tasks', 'no chores'])).toEqual({
			key: 'home_quiet_prefix',
			params: { list: 'no tasks, no chores' },
		});
		expect(composeQuietLine(['a', 'b', 'c'])?.key).toBe('home_quiet_prefix');
		expect(composeQuietLine(['a', 'b', 'c', 'd'])).toEqual({
			key: 'home_quiet_bare',
			params: {},
		});
	});

	it('speaks of "yet" for a new family', () => {
		expect(composeQuietLine(['a'], { fresh: true })?.key).toBe('home_quiet_prefix_new');
		expect(composeQuietLine(['a', 'b', 'c', 'd'], { fresh: true })?.key).toBe(
			'home_quiet_bare_new',
		);
	});

	it('is dropped when there is nothing to say, or the quiet-day hero says it', () => {
		expect(composeQuietLine([])).toBeNull();
		expect(composeQuietLine(['a', 'b', 'c', 'd'], { hero: true })).toBeNull();
	});

	it('is dropped while something waits for the person to check', () => {
		expect(composeQuietLine(['no tasks'], { waiting: true })).toBeNull();
		expect(composeQuietLine(['a', 'b', 'c', 'd'], { fresh: true, waiting: true })).toBeNull();
	});
});

describe('a light day looks ahead', () => {
	const item = (id: string, day: string, start?: number, extra: Partial<DayItem> = {}) =>
		({
			id,
			day,
			title: id,
			kind: 'event',
			href: '/calendar',
			...(start && { start }),
			...extra,
		}) as DayItem;

	it('is light with fewer than three things on the timeline', () => {
		expect(isLightDay(0)).toBe(true);
		expect(isLightDay(2)).toBe(true);
		expect(isLightDay(3)).toBe(false);
	});

	it('looks at the six days after the timeline day', () => {
		expect(aheadWindow('2026-10-09', false)).toEqual({ from: '2026-10-10', to: '2026-10-15' });
		// In the evening the timeline is tomorrow already.
		expect(aheadWindow('2026-10-09', true)).toEqual({ from: '2026-10-11', to: '2026-10-16' });
	});

	it('orders by day, then by the order of the day, and keeps the first four', () => {
		const out = nextDays([
			[
				item('sun-late', '2026-10-11', 15),
				item('sun-allday', '2026-10-11', undefined, { slot: 'allday' }),
			],
			[
				item('sat', '2026-10-10', 9),
				item('sun-early', '2026-10-11', 10),
				item('mon', '2026-10-12', 8),
			],
		]);
		expect(out.map((i) => i.id)).toEqual(['sat', 'sun-allday', 'sun-early', 'sun-late']);
		expect(nextDays([], 4)).toEqual([]);
	});
});

describe('the capture box', () => {
	const base = { canCapture: true, fresh: false, plan: 0, evening: false };
	it('is on the page for a new family or a day with nothing on the timeline, never in the evening', () => {
		expect(showCaptureBox(base)).toBe(true);
		expect(showCaptureBox({ ...base, plan: 2 })).toBe(false);
		expect(showCaptureBox({ ...base, plan: 2, fresh: true })).toBe(true);
		expect(showCaptureBox({ ...base, evening: true })).toBe(false);
		expect(showCaptureBox({ ...base, canCapture: false })).toBe(false);
	});
});
