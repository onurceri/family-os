import { describe, expect, it } from 'vitest';
import { weekdaysShiftedWithDate } from '../src/server/weekdays.ts';

describe('weekdaysShiftedWithDate', () => {
	it('moves every day by the same number of weekdays', () => {
		expect(weekdaysShiftedWithDate(['TU'], '2026-10-13', '2026-10-14')).toEqual(['WE']);
		expect(weekdaysShiftedWithDate(['TU', 'TH'], '2026-10-13', '2026-10-14')).toEqual(['WE', 'FR']);
		expect(weekdaysShiftedWithDate(['SA', 'SU'], '2026-10-17', '2026-10-19')).toEqual(['MO', 'TU']);
		expect(weekdaysShiftedWithDate(['TU', 'TH'], '2026-10-13', '2026-10-12')).toEqual(['MO', 'WE']);
	});

	it('keeps the days when the weekday stays or the start was not on one of them', () => {
		expect(weekdaysShiftedWithDate(['TU'], '2026-10-13', '2026-10-20')).toEqual(['TU']);
		expect(weekdaysShiftedWithDate(['TU'], '2026-10-12', '2026-10-14')).toEqual(['TU']);
	});
});
