import { describe, expect, it } from 'vitest';
import { defaultMode, isNight, parseMode } from './day-night.js';

const at = (iso: string) => Date.parse(iso);

describe('isNight', () => {
	it('keeps the fixed looks and the system setting', () => {
		const now = at('2026-06-01T12:00:00Z');
		expect(isNight('night', now, 'UTC', false)).toBe(true);
		expect(isNight('day', now, 'UTC', true)).toBe(false);
		expect(isNight('system', now, 'UTC', true)).toBe(true);
		expect(isNight('system', now, 'UTC', false)).toBe(false);
	});

	it('by time: night from 20:00 until 06:00 in the time zone, whatever the system says', () => {
		expect(isNight('time', at('2026-06-01T19:59:00Z'), 'UTC', true)).toBe(false);
		expect(isNight('time', at('2026-06-01T20:00:00Z'), 'UTC', false)).toBe(true);
		expect(isNight('time', at('2026-06-02T05:59:00Z'), 'UTC', false)).toBe(true);
		expect(isNight('time', at('2026-06-02T06:00:00Z'), 'UTC', false)).toBe(false);
	});

	it('by time: the hour is the family time zone hour, not the device hour', () => {
		const now = at('2026-06-01T12:00:00Z');
		expect(isNight('time', now, 'Asia/Tokyo', false)).toBe(true); // 21:00
		expect(isNight('time', now, 'America/New_York', false)).toBe(false); // 08:00
	});
});

describe('modes', () => {
	it('stores only the explicit choices', () => {
		expect(parseMode('time')).toBe('time');
		expect(parseMode('night')).toBe('night');
		expect(parseMode('system')).toBeNull();
		expect(parseMode(null)).toBeNull();
	});

	it('displays default to the time of day, other devices to the system', () => {
		expect(defaultMode(true)).toBe('time');
		expect(defaultMode(false)).toBe('system');
	});
});
