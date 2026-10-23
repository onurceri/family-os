import { type Actor, systemActor, type UploadedFile } from '@famos/sdk';
import { createTestKernel, samplePhoto, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PhotoOfTheDay } from '../src/contract/index.ts';
import ambient from '../src/server/index.ts';
import { dayNumber, pickForDay } from '../src/server/photo-of-the-day.ts';

const TZ = 'Pacific/Auckland'; // far from UTC, so a UTC day and the family's day differ
const at = (date: string, time: string) => epochOf(date, time, TZ);

let k: TestKernel;
let admin: Actor;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [ambient] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	admin = (await k.member('admin')).actor;
	k.clock.set(at('2026-03-14', '10:00'));
});
afterEach(() => k.close());

const display = (capabilities: string[]): Actor => ({
	kind: 'display',
	deviceId: 'dev_1',
	capabilities,
	showNames: false,
});

const png = () => samplePhoto('image/png');
const upload = async (): Promise<string> => {
	const bytes = png();
	const file: UploadedFile = {
		field: 'files',
		name: 'p.png',
		type: 'image/png',
		size: bytes.length,
		stream: async function* () {
			yield bytes;
		},
		bytes: async () => bytes,
	};
	return (await k.route('ambient.uploadPhoto').call({ files: [file], actor: admin })).id;
};
const today = (actor: Actor = admin): Promise<PhotoOfTheDay> =>
	k.route('ambient.getPhotoOfTheDay').call({ actor });

describe('the photo of the day', () => {
	it('is empty with no photos', async () => {
		expect(await today()).toEqual({ photo: null });
	});

	it('is the same all day, another one the next day, and served by the photo route', async () => {
		const ids = [await upload(), await upload(), await upload(), await upload()];
		const morning = await today();
		expect(ids).toContain(morning.photo?.id);
		expect(morning.photo?.month).toBe('2026-03');

		k.clock.set(at('2026-03-14', '00:00'));
		expect(await today()).toEqual(morning);
		k.clock.set(at('2026-03-14', '23:59'));
		expect(await today()).toEqual(morning);
		expect(await today(display(['ambient.photos']))).toEqual(morning);

		// Midnight in the family's time zone (still the 14th in UTC) starts a new day.
		k.clock.set(at('2026-03-15', '00:01'));
		const next = await today();
		expect(next.photo?.id).not.toBe(morning.photo?.id);

		const served = await k.route('ambient.getPhoto').call({ params: { photoId: next.photo?.id } });
		expect(served.contentType).toBe('image/png');
	});

	it('labels the month the photo was added in the family time zone', async () => {
		// 1 April 08:00 in Auckland is still 31 March in UTC.
		k.clock.set(at('2026-04-01', '08:00'));
		await upload();
		expect((await today()).photo?.month).toBe('2026-04');
	});

	it('needs ambient.photos: members hold it, a display only when granted', () => {
		const route = k.registry.routes.find(
			(r) => r.route.operationId === 'ambient.getPhotoOfTheDay',
		)?.route;
		expect(route?.requires).toBe('ambient.photos');
		expect(k.access.can(admin, 'ambient.photos')).toBe(true);
		expect(k.access.can(display(['ambient.photos']), 'ambient.photos')).toBe(true);
		expect(k.access.can(display(['ambient.weather']), 'ambient.photos')).toBe(false);
		expect(k.access.can(display(['calendar.view']), 'ambient.photos')).toBe(false);
	});

	it('is matched before a photo id', () => {
		const order = k.registry.routes
			.filter((r) => r.extension === 'ambient')
			.map((r) => r.route.operationId);
		expect(order.indexOf('ambient.getPhotoOfTheDay')).toBeLessThan(
			order.indexOf('ambient.getPhoto'),
		);
	});
});

describe('pickForDay', () => {
	const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

	it('picks nothing from nothing and the one photo there is every day', () => {
		expect(pickForDay([], 100)).toBeNull();
		expect([1, 2, 3].map((d) => pickForDay(['a'], d))).toEqual(['a', 'a', 'a']);
	});

	it('never shows the same photo two days in a row, and shows each once a round', () => {
		for (const n of [2, 3, 4, 7, 20]) {
			const list = ids(n);
			const start = dayNumber('2026-01-01');
			const days = Array.from({ length: n * 6 }, (_, i) => pickForDay(list, start + i));
			for (let i = 1; i < days.length; i++) expect(days[i]).not.toBe(days[i - 1]);
			// Each round of n days (aligned to the round) holds every photo once.
			const first = Math.ceil(start / n) * n - start;
			const round = days.slice(first, first + n);
			expect(new Set(round).size).toBe(n);
		}
	});

	it('is the same for the same day and set of photos', () => {
		const list = ids(9);
		expect(pickForDay(list, 20_000)).toBe(pickForDay([...list], 20_000));
	});

	it('counts days from the date, not the clock', () => {
		expect(dayNumber('1970-01-02')).toBe(1);
		expect(dayNumber('2026-03-15') - dayNumber('2026-03-14')).toBe(1);
	});
});
