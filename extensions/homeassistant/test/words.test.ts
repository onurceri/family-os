import { describe, expect, it } from 'vitest';
import en from '../src/messages/en.json' with { type: 'json' };
import tr from '../src/messages/tr.json' with { type: 'json' };
import { describeValue, numberWords, timeWords, type WordDeps } from '../src/web/words.ts';

const deps = (catalog: Record<string, string> = en): WordDeps => ({
	t: (key) => catalog[key] as string,
	number: (n) => numberWords(n, 'en-US'),
	time: (at) => `time:${at}`,
});

const binary = (deviceClass: string | null, on: boolean) =>
	describeValue({ kind: 'binary', on, deviceClass }, deps());

describe('describeValue', () => {
	it('says a number with its unit, at most one decimal', () => {
		expect(describeValue({ kind: 'number', value: 21.5, unit: '°C' }, deps()).text).toBe('21.5 °C');
		expect(describeValue({ kind: 'number', value: 21, unit: '°C' }, deps()).text).toBe('21 °C');
		expect(describeValue({ kind: 'number', value: 21.46, unit: '%' }, deps()).text).toBe('21.5 %');
		expect(describeValue({ kind: 'number', value: 1234.5, unit: null }, deps()).text).toBe(
			'1,234.5',
		);
	});

	it('does not round a small reading away', () => {
		expect(describeValue({ kind: 'number', value: 0.00275, unit: 'MWh' }, deps()).text).toBe(
			'0.0028 MWh',
		);
		expect(describeValue({ kind: 'number', value: 0, unit: 'W' }, deps()).text).toBe('0 W');
	});

	it('follows the region’s number format', () => {
		const german: WordDeps = { ...deps(), number: (n) => numberWords(n, 'de-DE') };
		expect(describeValue({ kind: 'number', value: 21.5, unit: '°C' }, german).text).toBe('21,5 °C');
	});

	it('says unavailable softly', () => {
		expect(describeValue({ kind: 'unavailable' }, deps())).toEqual({
			text: 'Not available',
			tone: 'soft',
		});
	});

	it('says text as it is', () => {
		expect(describeValue({ kind: 'text', text: 'eco' }, deps())).toEqual({
			text: 'eco',
			tone: 'ink',
		});
	});

	it('says a time through the time formatter', () => {
		expect(describeValue({ kind: 'time', at: 5 }, deps()).text).toBe('time:5');
	});

	it.each([
		['door', 'Open', 'Closed'],
		['window', 'Open', 'Closed'],
		['garage_door', 'Open', 'Closed'],
		['opening', 'Open', 'Closed'],
		['motion', 'Detected', 'Clear'],
		['occupancy', 'Detected', 'Clear'],
		['presence', 'Detected', 'Clear'],
		['moisture', 'Wet', 'Dry'],
		['smoke', 'Alert', 'OK'],
		['gas', 'Alert', 'OK'],
		['carbon_monoxide', 'Alert', 'OK'],
		['safety', 'Alert', 'OK'],
		['problem', 'Alert', 'OK'],
		['battery', 'Low', 'Normal'],
		['lock', 'Unlocked', 'Locked'],
		['plug', 'On', 'Off'],
		['power', 'On', 'Off'],
		['running', 'On', 'Off'],
		[null, 'On', 'Off'],
		['something_new', 'On', 'Off'],
	])('says a %s binary sensor as %s and %s', (deviceClass, on, off) => {
		expect(binary(deviceClass, true).text).toBe(on);
		expect(binary(deviceClass, false).text).toBe(off);
	});

	it('says a lock, a cover and a thermostat', () => {
		const state = (
			domain: 'lock' | 'cover' | 'climate',
			word: string,
			temperature: number | null = null,
		) => describeValue({ kind: 'state', domain, state: word, temperature }, deps());
		expect(state('lock', 'locked').text).toBe('Locked');
		expect(state('lock', 'unlocking').text).toBe('Unlocking…');
		expect(state('lock', 'jammed').tone).toBe('attention');
		expect(state('cover', 'closed').text).toBe('Closed');
		expect(state('cover', 'opening').text).toBe('Opening…');
		expect(state('climate', 'heat', 21.5).text).toBe('heat · 21.5');
		expect(state('climate', 'off').text).toBe('off');
	});

	it('asks for a look at an alert, and at nothing else', () => {
		expect(binary('smoke', true).tone).toBe('attention');
		expect(binary('smoke', false).tone).toBe('ink');
		expect(binary('door', true).tone).toBe('ink');
	});

	it('has every word in Turkish too', () => {
		for (const key of Object.keys(en).filter((k) => k.startsWith('value_')))
			expect(tr).toHaveProperty(key);
	});
});

describe('timeWords', () => {
	const now = Date.parse('2026-10-17T12:00:00Z');
	it('says a time today as a clock time', () => {
		expect(timeWords(Date.parse('2026-10-17T09:30:00Z'), now, 'en-GB', 'h23', 'UTC')).toBe('09:30');
		expect(timeWords(Date.parse('2026-10-17T21:30:00Z'), now, 'en-US', 'h12', 'UTC')).toBe(
			'09:30 PM',
		);
	});

	it('adds the date for another day, in the family’s time zone', () => {
		expect(timeWords(Date.parse('2026-10-16T09:30:00Z'), now, 'en-GB', 'h23', 'UTC')).toBe(
			'16 Oct, 09:30',
		);
		// 23:30 UTC is already the 18th in Tokyo, and so is not "today" there.
		expect(
			timeWords(Date.parse('2026-10-17T23:30:00Z'), now, 'en-GB', 'h23', 'Asia/Tokyo'),
		).toContain('18');
	});
});
