import { describe, expect, it } from 'vitest';
import { logLines } from '../src/web/log-lines.ts';

const dateOf = (day: string) => `on ${day}`;

describe('logLines', () => {
	it('titles an entry by its kind and day and lists the place and notes', () => {
		expect(
			logLines({ doneOn: '2026-10-19', place: 'Garage', notes: 'Oil' }, 'Service', dateOf),
		).toEqual({ title: 'Service · on 2026-10-19', parts: ['Garage', 'Oil'] });
	});

	it('leaves out what is not there', () => {
		expect(logLines({ doneOn: '2026-10-19', place: null, notes: ' ' }, 'Repair', dateOf)).toEqual({
			title: 'Repair · on 2026-10-19',
			parts: [],
		});
		expect(logLines({}, 'Repair', dateOf)).toEqual({ title: 'Repair', parts: [] });
	});
});
