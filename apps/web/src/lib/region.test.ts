import { describe, expect, it } from 'vitest';
import { offsetOf, startingFormatLocales, timeZoneOptions } from './region.js';

describe('starting region formats', () => {
	it('offers the current one, the browser one and each installed language with its region', () => {
		expect(startingFormatLocales('sl-SI', 'sl-SI', ['en', 'tr', 'sl'])).toEqual([
			'sl-SI',
			'en-SI',
			'tr-SI',
		]);
	});

	it('keeps the current choice first and drops tags that are not valid', () => {
		expect(startingFormatLocales('de-AT', 'en-US', ['en'])).toEqual(['de-AT', 'en-US']);
		expect(startingFormatLocales('not a tag', 'en-GB', ['en'])).toEqual(['en-GB']);
	});
});

describe('time zones', () => {
	it('always offers UTC and labels zones with their offset', () => {
		const zones = timeZoneOptions(new Date(Date.UTC(2026, 0, 15)));
		expect(zones.some((z) => z.value === 'UTC')).toBe(true);
		expect(zones.find((z) => z.value === 'Europe/Ljubljana')?.label).toBe(
			'Europe/Ljubljana (GMT+1)',
		);
	});

	it('gives no offset for a zone that does not exist', () => {
		expect(offsetOf('Nowhere/Atlantis')).toBe('');
	});
});
