import { epochOf } from '@famos/time';
import { describe, expect, it } from 'vitest';
import type { ForecastHour } from '../src/contract/index.ts';
import { type SentenceItem, weatherSentence } from '../src/contract/sentence.ts';

const timeZone = 'Europe/Istanbul';
const format = { timeZone, formatLocale: 'en-GB', dateLocale: 'en-GB', hourCycle: 'h23' } as const;
const DAY = '2026-10-09';
const at = (time: string, date = DAY) => epochOf(date, time, timeZone);

type Hour = Partial<Omit<ForecastHour, 'at'>>;

/** Two days of hours from midnight: 12° and cloudy unless an hour (0–47) says otherwise. */
function hours(overrides: Record<number, Hour> = {}, base: Hour = {}): ForecastHour[] {
	return Array.from({ length: 48 }, (_, i) => ({
		at: at('00:00') + i * 3_600_000,
		temperature: 12,
		code: 3,
		precipitationProbability: 0,
		...base,
		...overrides[i],
	}));
}
const range = (from: number, to: number, hour: Hour) =>
	Object.fromEntries(Array.from({ length: to - from }, (_, i) => [from + i, hour]));

const say = (
	hourly: ForecastHour[],
	now: string,
	items: SentenceItem[] = [],
	extra: { temperature?: number; unit?: 'celsius' | 'fahrenheit' } = {},
) =>
	weatherSentence(
		{ temperature: extra.temperature ?? 12, unit: extra.unit ?? 'celsius', hourly },
		items,
		at(now),
		format,
	);

describe('weatherSentence', () => {
	it('names the item a rain window starts during, by time only', () => {
		const hourly = hours(range(16, 19, { code: 61 }));
		expect(say(hourly, '11:00', [{ title: 'Football practice', start: at('17:00') }])).toEqual({
			key: 'wx_say_rain_from_event',
			params: { time: '16:00', event: 'Football practice' },
		});
	});

	it('ignores items outside the window or already started', () => {
		const hourly = hours(range(16, 19, { code: 61 }));
		const items = [
			{ title: 'Before', start: at('15:00') },
			{ title: 'After', start: at('19:00') },
		];
		expect(say(hourly, '11:00', items)).toEqual({
			key: 'wx_say_rain_from',
			params: { time: '16:00', end: '19:00' },
		});
	});

	it('counts a high chance of rain as rain, and follows the window past midnight', () => {
		const hourly = hours(range(21, 27, { precipitationProbability: 60 }));
		expect(say(hourly, '09:00', [], { temperature: 12 })).toEqual({
			key: 'wx_say_rain_from',
			params: { time: '21:00', end: '03:00' },
		});
	});

	it('says when rain that is falling now stops, and what comes after', () => {
		const hourly = hours({ ...range(8, 13, { code: 63 }), 13: { code: 2 } });
		expect(say(hourly, '09:30')).toEqual({
			key: 'wx_say_rain_until',
			params: { time: '13:00' },
			label: 'wx_then_partly_cloudy',
		});
	});

	it('says rain all day when it rains from now to the end of the day', () => {
		const hourly = hours({ ...range(0, 30, { code: 61 }), 15: { code: 61, temperature: 17 } });
		expect(say(hourly, '08:00')).toEqual({ key: 'wx_say_rain_all_day', params: { max: '17' } });
	});

	it('speaks of snow and storms with their own keys', () => {
		expect(say(hours(range(14, 18, { code: 73 })), '09:00')).toEqual({
			key: 'wx_say_snow_from',
			params: { time: '14:00' },
		});
		expect(say(hours({ ...range(14, 18, { code: 61 }), 16: { code: 95 } }), '09:00')).toEqual({
			key: 'wx_say_storm_from',
			params: { time: '14:00' },
		});
	});

	it('says sunny and dry when every hour left is clear', () => {
		const hourly = hours({ 15: { code: 0, temperature: 22 } }, { code: 0 });
		expect(say(hourly, '11:00')).toEqual({
			key: 'wx_say_dry_sunny',
			params: { max: '22', time: '15:00' },
		});
	});

	it('says dry with the warmest hour otherwise', () => {
		const hourly = hours({ 14: { temperature: 18.6 }, 15: { temperature: 18.6 } });
		expect(say(hourly, '11:00')).toEqual({
			key: 'wx_say_dry',
			params: { max: '19', time: '14:00' },
		});
	});

	it('says a cold morning before 10:00 when the day warms by 8° or more', () => {
		const hourly = hours({ 14: { temperature: 13 } }, { temperature: 6 });
		expect(say(hourly, '07:30', [], { temperature: 4 })).toEqual({
			key: 'wx_say_cold_morning',
			params: { min: '4', max: '13', time: '14:00' },
		});
		// Not after 10:00, and not with a smaller swing.
		expect(say(hourly, '10:30', [], { temperature: 4 })?.key).toBe('wx_say_dry');
		expect(say(hourly, '07:30', [], { temperature: 6 })?.key).toBe('wx_say_dry');
	});

	it('measures the cold swing in the forecast’s unit', () => {
		const hourly = hours({ 14: { temperature: 50 } }, { temperature: 40 });
		const f = (temperature: number) =>
			say(hourly, '07:00', [], { temperature, unit: 'fahrenheit' })?.key;
		expect(f(40)).toBe('wx_say_dry');
		expect(f(36)).toBe('wx_say_cold_morning');
	});

	it('speaks of tonight after 20:00, with the low until the morning', () => {
		const hourly = hours({
			21: { temperature: 9 },
			29: { temperature: 4 },
			31: { temperature: 2 },
		});
		expect(say(hourly, '20:15', [], { temperature: 11 })).toEqual({
			key: 'wx_say_evening',
			params: { temp: '11', min: '4' },
		});
	});

	it('speaks of tonight once the last item has started, from 17:00', () => {
		const hourly = hours(range(19, 21, { code: 61 }));
		const items = [{ title: 'Dinner', start: at('17:30') }];
		expect(say(hourly, '17:45', items)?.key).toBe('wx_say_evening');
		expect(say(hourly, '17:15', items)?.key).toBe('wx_say_rain_from');
		expect(say(hourly, '16:00', [{ title: 'Early', start: at('09:00') }])?.key).toBe(
			'wx_say_rain_from',
		);
	});

	it('formats times in the hour cycle and format locale it is given', () => {
		const hourly = hours(range(16, 19, { code: 61 }));
		const sentence = weatherSentence(
			{ temperature: 12, unit: 'celsius', hourly },
			[],
			at('11:00'),
			{
				timeZone,
				formatLocale: 'en-US',
				dateLocale: 'en-US',
				hourCycle: 'h12',
			},
		);
		expect(sentence?.params.time).toMatch(/^4:00\sPM$/);
	});

	it('says nothing without hours (a forecast cached before they were fetched)', () => {
		expect(
			weatherSentence({ temperature: 12, unit: 'celsius' }, [], at('11:00'), format),
		).toBeNull();
		expect(say(hours().slice(0, 5), '11:00')).toBeNull();
	});
});
