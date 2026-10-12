import { describe, expect, it } from 'vitest';
import { type RepeatUnit, withRepeat } from '../src/web/repeat.ts';

const form = (repeat: RepeatUnit, interval: number) => ({ title: 'Service', repeat, interval });

describe('withRepeat', () => {
	it('starts at a few months or years, never at every single one', () => {
		expect(withRepeat(form('none', 1), 'months')).toMatchObject({ repeat: 'months', interval: 3 });
		expect(withRepeat(form('none', 1), 'years')).toMatchObject({ repeat: 'years', interval: 2 });
	});

	it('keeps an interval that was already chosen and clears the rule on none', () => {
		expect(withRepeat(form('months', 6), 'years').interval).toBe(6);
		expect(withRepeat(form('none', 12), 'months').interval).toBe(12);
		expect(withRepeat(form('months', 3), 'none')).toMatchObject({
			repeat: 'none',
			title: 'Service',
		});
	});
});
