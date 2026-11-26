import { describe, expect, it } from 'vitest';
import {
	formatTimes,
	mayAddTime,
	mineState,
	nextTime,
	type PreferencesView,
	timesProblem,
} from '../src/web/reminder-times.ts';

it('says what keeps a list of times from being saved', () => {
	expect(timesProblem([])).toBe('empty');
	expect(timesProblem(['18:00', ''])).toBe('invalid');
	expect(timesProblem(['18:00', '18:00'])).toBe('duplicate');
	expect(timesProblem(['08:00', '18:00'])).toBeNull();
});

it('allows up to four times', () => {
	expect(mayAddTime(['08:00', '09:00', '10:00'])).toBe(true);
	expect(mayAddTime(['08:00', '09:00', '10:00', '11:00'])).toBe(false);
});

it('offers a free time for a new row, within the day', () => {
	expect(nextTime(['18:00'])).toBe('20:00');
	expect(nextTime(['23:00'])).toBe('01:00');
	expect(nextTime([])).toBe('16:00');
	expect(nextTime(['20:00', '18:00'])).toBe('22:00');
});

describe('whether the evening count reaches the viewer', () => {
	const kind = { id: 'chores.leftToday', defaultChannels: [] };
	const channels = [
		{ id: 'webpush', available: true },
		{ id: 'telegram', available: false },
	];
	const view = (chosen: Record<string, boolean> | undefined): PreferencesView => ({
		kinds: [kind],
		channels,
		prefs: { kinds: chosen ? { 'chores.leftToday': chosen } : {} },
	});

	it('is on when a channel that reaches them is switched on', () => {
		expect(mineState(view({ webpush: true }))).toBe('on');
	});

	it('is off when nothing is switched on, or only a channel that cannot reach them', () => {
		expect(mineState(view(undefined))).toBe('off');
		expect(mineState(view({ webpush: false }))).toBe('off');
		expect(mineState(view({ webpush: false, telegram: true }))).toBe('off');
	});

	it('follows the default of a channel not chosen yet', () => {
		const onByDefault = { ...view(undefined), kinds: [{ ...kind, defaultChannels: ['webpush'] }] };
		expect(mineState(onByDefault)).toBe('on');
	});

	it('says a channel is needed when the kind is not offered to them', () => {
		expect(mineState({ kinds: [], channels, prefs: { kinds: {} } })).toBe('no-channel');
	});

	it('says nothing without preferences', () => {
		expect(mineState(null)).toBeNull();
	});
});

it('writes the times on the family clock, joined with commas', () => {
	expect(formatTimes(['18:00', '20:30'], 'en-GB', 'h23')).toBe('18:00, 20:30');
	expect(formatTimes(['18:00'], 'en-US', 'h12')).toMatch(/^6:00\sPM$/);
	expect(formatTimes([], 'en-GB', 'h23')).toBe('');
});
