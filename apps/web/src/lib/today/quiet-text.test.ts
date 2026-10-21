import { describe, expect, it } from 'vitest';
import { quietTextKey } from './quiet-text.js';

describe('quietTextKey', () => {
	it('says nothing waits only when nothing does', () => {
		expect(quietTextKey({ family: false, week: false, waiting: 0 })).toBe('home_quiet_text');
		expect(quietTextKey({ family: false, week: true, waiting: 0 })).toBe('home_quiet_text_week');
	});
	it('drops the clause when something waits for the person', () => {
		expect(quietTextKey({ family: false, week: false, waiting: 1 })).toBe('home_quiet_text_open');
		expect(quietTextKey({ family: false, week: true, waiting: 3 })).toBe(
			'home_quiet_text_week_open',
		);
	});
	it('keeps the display texts', () => {
		expect(quietTextKey({ family: true, week: false, waiting: 2 })).toBe('home_quiet_text_family');
		expect(quietTextKey({ family: true, week: true, waiting: 0 })).toBe(
			'home_quiet_text_week_family',
		);
	});
});
