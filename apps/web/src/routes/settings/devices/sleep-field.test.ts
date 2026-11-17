import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FROM,
	DEFAULT_UNTIL,
	sleepChanged,
	sleepChoiceOf,
	sleepProblem,
	sleepToSave,
} from './sleep-field.js';

describe('sleep choice', () => {
	it('starts off with the usual night', () => {
		expect(sleepChoiceOf(null)).toEqual({ on: false, from: DEFAULT_FROM, until: DEFAULT_UNTIL });
		expect(DEFAULT_FROM).toBe('22:00');
		expect(DEFAULT_UNTIL).toBe('07:00');
	});

	it('sends hours only while it is on and the times are filled in', () => {
		expect(sleepToSave({ on: false, from: '22:00', until: '07:00' })).toBeNull();
		expect(sleepToSave({ on: true, from: '23:00', until: '06:30' })).toEqual({
			from: '23:00',
			until: '06:30',
		});
		expect(sleepToSave({ on: true, from: '', until: '06:30' })).toBeNull();
	});

	it('refuses two equal times only while on', () => {
		expect(sleepProblem({ on: true, from: '22:00', until: '22:00' })).toBe(true);
		expect(sleepProblem({ on: false, from: '22:00', until: '22:00' })).toBe(false);
		expect(sleepProblem({ on: true, from: '22:00', until: '07:00' })).toBe(false);
	});

	it('tells a change from what is saved', () => {
		const saved = { from: '22:00', until: '07:00' };
		expect(sleepChanged(sleepChoiceOf(saved), saved)).toBe(false);
		expect(sleepChanged({ on: false, from: '22:00', until: '07:00' }, saved)).toBe(true);
		expect(sleepChanged({ on: true, from: '23:00', until: '07:00' }, saved)).toBe(true);
		expect(sleepChanged(sleepChoiceOf(null), null)).toBe(false);
		expect(sleepChanged({ on: true, from: '22:00', until: '07:00' }, null)).toBe(true);
	});
});
