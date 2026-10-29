import type { AppContext } from '@famos/ui/app';
import { describe, expect, it } from 'vitest';
import { captureTime } from '../src/web/format.ts';

const app = (hourCycle: 'h12' | 'h23', dateLocale: string) =>
	({
		dateLocale: () => dateLocale,
		hourCycle: () => hourCycle,
		timeZone: () => 'UTC',
	}) as AppContext;

// Thursday 2026-10-29, 18:52 UTC.
const at = Date.UTC(2026, 9, 29, 18, 52);

describe('captureTime', () => {
	it('writes a 12-hour clock without a leading zero, as Today does', () => {
		expect(captureTime(app('h12', 'en-US'), at)).toBe('Thu 6:52 PM');
		expect(captureTime(app('h12', 'en-US'), Date.UTC(2026, 9, 29, 9, 5))).toBe('Thu 9:05 AM');
	});

	it('keeps two digits on a 24-hour clock', () => {
		expect(captureTime(app('h23', 'en-GB'), Date.UTC(2026, 9, 29, 9, 5))).toBe('Thu 09:05');
		expect(captureTime(app('h23', 'en-GB'), at)).toBe('Thu 18:52');
	});
});
