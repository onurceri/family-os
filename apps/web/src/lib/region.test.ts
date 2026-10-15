import { describe, expect, it } from 'vitest';
import {
	offsetOf,
	regionFormatLocale,
	regionOptions,
	startingFormatLocales,
	timeZoneOptions,
} from './region.js';

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

describe('region options', () => {
	it("names every region in the reader's language, sorted by name", () => {
		const english = regionOptions('en');
		expect(english).toContainEqual({ value: 'sl-SI', label: 'Slovenia' });
		expect(english).toContainEqual({ value: 'en-US', label: 'United States' });
		const turkish = regionOptions('tr');
		expect(turkish).toContainEqual({ value: 'sl-SI', label: 'Slovenya' });
		const labels = turkish.map((o) => o.label);
		expect(labels).toEqual(labels.toSorted(new Intl.Collator('tr').compare));
		expect(english.length).toBeGreaterThan(200);
	});

	it('puts a current or browser tag the list lacks first, once', () => {
		const options = regionOptions('en', ['en-SI', 'en-si', 'sl-SI', 'not a tag']);
		expect(options[0]).toEqual({ value: 'en-SI', label: 'English (Slovenia)' });
		expect(options.filter((o) => o.value === 'en-SI')).toHaveLength(1);
		expect(options.filter((o) => o.value === 'sl-SI')).toHaveLength(1);
		expect(options.some((o) => o.value === 'not a tag')).toBe(false);
	});
});
