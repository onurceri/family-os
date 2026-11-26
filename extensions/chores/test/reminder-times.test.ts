import { expect, it } from 'vitest';
import { mayAddTime, nextTime, timesProblem } from '../src/web/reminder-times.ts';

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
