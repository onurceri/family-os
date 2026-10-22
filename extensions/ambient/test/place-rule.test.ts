import { describe, expect, it } from 'vitest';
import type { Place } from '../src/contract/index.ts';
import { asksForPlace, placeChoice } from '../src/web/place-rule.ts';

const place: Place = { name: 'Ljubljana', latitude: 46.05, longitude: 14.5 };
const before: Place = { name: 'Maribor', latitude: 46.55, longitude: 15.65 };

describe('placeChoice', () => {
	it('turns the weather on for the first place', () => {
		expect(placeChoice({ enabled: false, place: null }, place)).toMatchObject({
			enabled: true,
			firstPlace: true,
		});
	});

	it('leaves the switch off when the place changes later', () => {
		expect(placeChoice({ enabled: false, place: before }, place)).toMatchObject({
			enabled: false,
			firstPlace: false,
		});
	});

	it('leaves the switch on when the place changes later', () => {
		expect(placeChoice({ enabled: true, place: before }, place)).toMatchObject({
			enabled: true,
			firstPlace: false,
		});
	});
});

describe('asksForPlace', () => {
	it('is true when the address carries place, whatever its value', () => {
		expect(asksForPlace('?place=1')).toBe(true);
		expect(asksForPlace('?x=1&place')).toBe(true);
	});

	it('is false without it', () => {
		expect(asksForPlace('')).toBe(false);
		expect(asksForPlace('?replace=1')).toBe(false);
	});
});
