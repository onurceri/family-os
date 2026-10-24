import { describe, expect, it } from 'vitest';
import { relativeDayLabel } from '../src/index.ts';

const words = {
	overdue: (days: number) => `${days} days overdue`,
	yesterday: 'Yesterday',
	today: 'Today',
	tomorrow: 'Tomorrow',
};
const label = (date: string) => relativeDayLabel(date, '2026-10-21', 'en-GB', words);

describe('relativeDayLabel', () => {
	it('words the days around today', () => {
		expect(label('2026-10-18')).toBe('3 days overdue');
		expect(label('2026-10-20')).toBe('Yesterday');
		expect(label('2026-10-21')).toBe('Today');
		expect(label('2026-10-22')).toBe('Tomorrow');
	});
	it('names the weekday within a week and the date after', () => {
		expect(label('2026-10-27')).toBe('Tuesday');
		expect(label('2026-10-28')).toBe('Wed 28 Oct');
	});
});
