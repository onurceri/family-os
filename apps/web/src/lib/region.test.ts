import { describe, expect, it } from 'vitest';
import { offsetOf, regionFormatLocale, startingFormatLocales, timeZoneOptions } from './region.js';

describe('the region format a browser describes', () => {
	it('is the first preferred tag with a region, whatever language the app speaks', () => {
		expect(regionFormatLocale(['sl-SI', 'en-GB', 'en'])).toBe('sl-SI');
		expect(regionFormatLocale(['sl', 'en-GB'])).toBe('en-GB');
	});

	it('falls back to a bare language, then en-US', () => {
		expect(regionFormatLocale(['sl', 'en'])).toBe('sl');
		expect(regionFormatLocale(['not a tag'])).toBe('en-US');
		expect(regionFormatLocale([])).toBe('en-US');
	});
});

describe('starting region formats', () => {
	it('offers the current one, then the browser tags in order, never mixed with the app language', () => {
		expect(startingFormatLocales('sl-SI', ['sl-SI', 'en-GB', 'en'])).toEqual([
			'sl-SI',
			'en-GB',
			'en',
		]);
	});

	it('drops tags that are not valid', () => {
		expect(startingFormatLocales('not a tag', ['en-GB'])).toEqual(['en-GB']);
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
