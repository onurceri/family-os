import { describe, expect, it } from 'vitest';
import { moveOffer } from '../src/web/instead.js';

const context = {
	t: (key: string, options?: Record<string, unknown>) =>
		options ? `${key} ${JSON.stringify(options)}` : key,
	members: [],
	formatLocale: 'en-GB',
	weekStart: 1,
	hourCycle: 'h23' as const,
	timeZone: 'Europe/Istanbul',
};

describe('moveOffer', () => {
	it('names the event there and when it is, and the new day and time', () => {
		expect(
			moveOffer(
				{ label: 'Regional Gala', date: '2026-11-14', startTime: '09:00' },
				{ date: '2026-11-07', time: '18:00' },
				context,
			),
		).toEqual({
			there: 'calendar:draft_already_there {"what":"Regional Gala · Sat 7 Nov 18:00"}',
			action: 'calendar:draft_move_instead {"when":"Sat 14 Nov 09:00"}',
		});
	});

	it('says only the day for an all-day event', () => {
		expect(
			moveOffer(
				{ label: 'School trip', date: '2026-10-22', allDay: true, startTime: '08:00' },
				{ date: '2026-10-20' },
				context,
			),
		).toEqual({
			there: 'calendar:draft_already_there {"what":"School trip · Tue 20 Oct"}',
			action: 'calendar:draft_move_instead {"when":"Thu 22 Oct"}',
		});
	});

	it('offers a plain change when the day stays', () => {
		expect(moveOffer({ label: 'Dentist' }, undefined, context)).toEqual({
			there: 'calendar:draft_already_there {"what":"Dentist"}',
			action: 'calendar:draft_change_instead',
		});
	});
});
