import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAction } from '../src/actions.ts';
import {
	ApiDateSchema,
	ApiInstantSchema,
	apiId,
	apiInstant,
	apiOutput,
	defineApi,
} from '../src/api.ts';

describe('apiInstant', () => {
	const noon = Date.UTC(2026, 9, 20, 12, 0, 0);

	it('writes an instant with the offset of the zone, whole hours or not', () => {
		expect(apiInstant(noon, 'UTC')).toBe('2026-10-20T12:00:00+00:00');
		expect(apiInstant(noon, 'Europe/Istanbul')).toBe('2026-10-20T15:00:00+03:00');
		expect(apiInstant(noon, 'America/New_York')).toBe('2026-10-20T08:00:00-04:00');
		expect(apiInstant(noon, 'Asia/Kolkata')).toBe('2026-10-20T17:30:00+05:30');
	});

	it('follows daylight saving time on either side of the change', () => {
		const winter = Date.UTC(2026, 0, 15, 12, 0, 0);
		expect(apiInstant(winter, 'Europe/Berlin')).toBe('2026-01-15T13:00:00+01:00');
		expect(apiInstant(Date.UTC(2026, 6, 15, 12, 0, 0), 'Europe/Berlin')).toBe(
			'2026-07-15T14:00:00+02:00',
		);
	});

	it('writes midnight as 00, never 24', () => {
		expect(apiInstant(Date.UTC(2026, 9, 20, 0, 0, 0), 'UTC')).toBe('2026-10-20T00:00:00+00:00');
	});

	it('is what the instant schema accepts, and the moment it names is the one given', () => {
		for (const zone of ['UTC', 'Europe/Istanbul', 'America/New_York', 'Asia/Kolkata']) {
			const text = apiInstant(noon, zone);
			expect(ApiInstantSchema.safeParse(text).success, text).toBe(true);
			expect(Date.parse(text)).toBe(noon);
		}
		expect(ApiInstantSchema.safeParse('2026-10-20T12:00:00').success).toBe(false);
	});
});

describe('the public API markers', () => {
	it('checks a day is a plain day', () => {
		expect(ApiDateSchema.safeParse('2026-10-20').success).toBe(true);
		expect(ApiDateSchema.safeParse('2026-10-20T12:00:00Z').success).toBe(false);
	});

	it('keeps one schema for an id prefix', () => {
		expect(apiId('cal_event')).toBe(apiId('cal_event'));
		expect(
			apiId('cal_event').safeParse('cal_event_0192b4c0-0000-7000-8000-000000000001').success,
		).toBe(true);
		expect(apiId('cal_event').safeParse('task_0192b4c0-0000-7000-8000-000000000001').success).toBe(
			false,
		);
	});

	it('leaves an action on the app’s own API when it is offered publicly', () => {
		const exposure = defineApi({ name: 'a.b', method: 'post', path: '/b', summary: 'B' });
		expect(exposure.api).toBe('v1');
		const action = defineAction({
			id: 'a.b',
			title: 'B',
			input: z.object({}),
			output: z.object({}),
			requires: 'a.edit',
			expose: exposure,
			async run() {
				return {};
			},
		});
		expect(action.expose).toBe('app');
		expect(action.api).toEqual([exposure]);
		const plain = defineAction({
			id: 'a.c',
			title: 'C',
			input: z.object({}),
			output: z.object({}),
			requires: 'a.edit',
			async run() {
				return {};
			},
		});
		expect(plain.api).toEqual([]);
		const internal = defineAction({
			id: 'a.d',
			title: 'D',
			input: z.object({}),
			output: z.object({}),
			expose: 'internal',
			async run() {
				return {};
			},
		});
		expect([internal.expose, internal.api]).toEqual(['internal', []]);
	});

	it('shapes an answer with the function it is given', () => {
		const output = apiOutput(z.object({ at: ApiInstantSchema }), (v: { at: number }, ctx) => ({
			at: apiInstant(v.at, ctx.timeZone),
		}));
		expect(
			output.project(
				{ at: Date.UTC(2026, 9, 20, 12) },
				{ timeZone: 'Europe/Istanbul', language: 'en', translate: (key) => key },
			),
		).toEqual({ at: '2026-10-20T15:00:00+03:00' });
	});
});
