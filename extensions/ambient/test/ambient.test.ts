import type { UploadedFile } from '@famos/sdk';
import { createTestKernel, GPS_MARKER, samplePhoto, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForecastSchema } from '../src/contract/index.ts';
import { WEATHER_TTL_MS } from '../src/server/caches.ts';
import ambient from '../src/server/index.ts';
import {
	MAX_LIBRARY,
	MAX_PHOTOS,
	PHOTO_MAX_BYTES,
	PHOTO_MAX_SIDE,
	shuffle,
} from '../src/server/photos.ts';
import { forecastUrl, parseForecast } from '../src/server/weather.ts';

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>['actor'];

beforeEach(async () => {
	k = await createTestKernel({ extensions: [ambient] });
	admin = (await k.member('admin')).actor;
});
afterEach(() => {
	vi.restoreAllMocks();
	return k.close();
});

const run = async <T>(id: string, input: unknown): Promise<T> => {
	const r = await k.runner.invoke<T>(id, input, admin);
	if (r.status !== 'applied') throw new Error('not applied');
	return r.output;
};

const display = (caps: string[]) => ({
	kind: 'display' as const,
	deviceId: 'dev_1',
	capabilities: caps,
	showNames: false,
});

/** Minimal valid headers: enough for the server to read the type and the size. */
const png = (width = 8, height = 6) => {
	const b = new Uint8Array(45);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(b.buffer).setUint32(16, width);
	new DataView(b.buffer).setUint32(20, height);
	// IEND, so the whole file is well formed.
	b.set([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44], 33);
	return b;
};
const jpeg = (width = 40, height = 30) => {
	const b = new Uint8Array(27);
	// SOI, APP0 (length 4), SOF0 (length 11, 8 bits, height, width), an empty scan and EOI.
	b.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8]);
	b.set([0xff, 0xda, 0, 2, 0xff, 0xd9], 21);
	new DataView(b.buffer).setUint16(13, height);
	new DataView(b.buffer).setUint16(15, width);
	return b;
};
const webp = (kind: 'VP8 ' | 'VP8L' | 'VP8X', width = 16, height = 12) => {
	const b = new Uint8Array(40);
	const text = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i);
	};
	text(0, 'RIFF');
	new DataView(b.buffer).setUint32(4, b.length - 8, true);
	new DataView(b.buffer).setUint32(16, b.length - 20, true);
	text(8, 'WEBP');
	text(12, kind);
	const view = new DataView(b.buffer);
	if (kind === 'VP8 ') {
		view.setUint16(26, width, true);
		view.setUint16(28, height, true);
	} else if (kind === 'VP8L') {
		b[20] = 0x2f;
		view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
	} else {
		view.setUint16(24, width - 1, true);
		b[26] = 0;
		view.setUint16(27, height - 1, true);
		b[29] = 0;
	}
	return b;
};

const file = (bytes: Uint8Array, type = 'image/jpeg', size = bytes.length): UploadedFile => ({
	field: 'files',
	name: 'p.jpg',
	type,
	size,
	stream: async function* () {
		yield bytes;
	},
	bytes: async () => bytes,
});
const upload = (f: UploadedFile, actor: typeof admin | ReturnType<typeof display> = admin) =>
	k.route('ambient.uploadPhoto').call({ files: [f], actor });
const library = () => k.route('ambient.listLibrary').call();
const listPhotos = () => k.route('ambient.listPhotos').call();
const read = async (photoId: string) => {
	const res = await k.route('ambient.getPhoto').call({ params: { photoId } });
	const chunks: Uint8Array[] = [];
	for await (const chunk of res.stream) chunks.push(chunk);
	return { ...res, bytes: Buffer.concat(chunks) };
};

describe('settings', () => {
	it('rounds the place to two decimals and needs a place to turn the weather on', async () => {
		await expect(
			k.runner.invoke('ambient.updateWeather', { enabled: true, place: null }, admin),
		).rejects.toMatchObject({ code: 'bad_request' });
		const saved = await run<{ weather: { place: { latitude: number; longitude: number } } }>(
			'ambient.updateWeather',
			{ enabled: true, place: { name: 'Istanbul', latitude: 41.01384, longitude: 28.94966 } },
		);
		expect(saved.weather.place).toMatchObject({ latitude: 41.01, longitude: 28.95 });
	});

	it('has defaults for the timing', async () => {
		expect((await k.route('ambient.getSettings').call()).timing).toEqual({
			idleMinutes: 5,
			slideSeconds: 30,
		});
		await run('ambient.updateTiming', { idleMinutes: 2, slideSeconds: 10 });
		expect((await k.route('ambient.getSettings').call()).timing).toEqual({
			idleMinutes: 2,
			slideSeconds: 10,
		});
		// One timing left out is refused, never put back to its default.
		await expect(run('ambient.updateTiming', { idleMinutes: 3 })).rejects.toMatchObject({
			code: 'bad_request',
		});
		expect((await k.route('ambient.getSettings').call()).timing).toEqual({
			idleMinutes: 2,
			slideSeconds: 10,
		});
	});
});

describe('photo upload', () => {
	it('stores a JPEG, PNG or WebP, reading its type and size from the bytes', async () => {
		const cases: [Uint8Array, string, number, number][] = [
			[jpeg(40, 30), 'image/jpeg', 40, 30],
			[png(8, 6), 'image/png', 8, 6],
			[webp('VP8 ', 16, 12), 'image/webp', 16, 12],
			[webp('VP8L', 20, 10), 'image/webp', 20, 10],
			[webp('VP8X', 30, 25), 'image/webp', 30, 25],
		];
		for (const [bytes, type, width, height] of cases) {
			// The declared type is only a claim: say JPEG for all of them.
			const { id } = await upload(file(bytes, 'image/jpeg'));
			expect(id).toMatch(/^amb_photo_/);
			const row = (await library()).find((p: { id: string }) => p.id === id);
			expect(row).toMatchObject({ contentType: type, width, height, size: bytes.length });
		}
		expect(await library()).toHaveLength(5);
	});

	it('stores a photo without its location data, whatever the app did', async () => {
		for (const type of ['image/jpeg', 'image/png', 'image/webp'] as const) {
			const withGps = samplePhoto(type, { gps: true });
			expect(Buffer.from(withGps).includes(GPS_MARKER)).toBe(true);
			const { id } = await upload(file(withGps, type));
			const stored = await read(id);
			expect(stored.bytes.includes(GPS_MARKER)).toBe(false);
			const row = (await library()).find((p: { id: string }) => p.id === id);
			expect(row).toMatchObject({ contentType: type, size: stored.bytes.length });
		}
	});

	it('records who uploaded it', async () => {
		await upload(file(png()));
		expect((await library())[0].uploadedBy).toBe(admin.memberId);
	});

	it('refuses something that is not an image, even when it says so', async () => {
		const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
		await expect(upload(file(html, 'image/jpeg'))).rejects.toMatchObject({ code: 'bad_request' });
		// A GIF, or a PNG signature without a header, is no display photo either.
		await expect(
			upload(file(new TextEncoder().encode('GIF89a......................'), 'image/png')),
		).rejects.toMatchObject({ code: 'bad_request' });
		await expect(upload(file(png().subarray(0, 12), 'image/png'))).rejects.toMatchObject({
			code: 'bad_request',
		});
		expect(await library()).toEqual([]);
	});

	it('refuses a photo that is too big, by size or by pixels', async () => {
		const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
		big.set(png());
		await expect(upload(file(big, 'image/png'))).rejects.toMatchObject({ code: 'bad_request' });
		await expect(upload(file(png(), 'image/png', PHOTO_MAX_BYTES + 1))).rejects.toMatchObject({
			code: 'bad_request',
		});
		await expect(upload(file(png(9000, 100), 'image/png'))).rejects.toMatchObject({
			code: 'bad_request',
		});
		await expect(
			k.route('ambient.uploadPhoto').call({ files: [], actor: admin }),
		).rejects.toMatchObject({
			code: 'bad_request',
		});
		expect(await library()).toEqual([]);
	});

	it('is for people who manage display content only', async () => {
		const child = (await k.member('supervised')).actor;
		await expect(upload(file(png()), child)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(upload(file(png()), display(['ambient.photos']))).rejects.toBeDefined();
		expect(await library()).toEqual([]);
		// A refused photo leaves no file behind: nothing to read back and the library stays empty.
		expect(await listPhotos()).toMatchObject({ ids: [] });
	});

	it('keeps at most the library cap and cleans up the file it refused', async () => {
		const spy = vi.spyOn(k.contextFor('ambient').files, 'delete');
		const insert = k.ctx.db.withTables<{ ambient_photos: Record<string, unknown> }>();
		await insert
			.insertInto('ambient_photos')
			.values(
				Array.from({ length: MAX_LIBRARY }, (_, i) => ({
					id: `amb_photo_${i}`,
					file_key: `ambient/photos/x${i}`,
					content_type: 'image/png',
					width: 1,
					height: 1,
					byte_size: 1,
					uploaded_by: null,
					created_at: i,
				})) as never,
			)
			.execute();
		await expect(upload(file(png()))).rejects.toMatchObject({ code: 'bad_request' });
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe('photo list and serving', () => {
	it('lists the library newest first', async () => {
		const first = await upload(file(png(1, 1)));
		k.clock.advance(1000);
		const second = await upload(file(jpeg()));
		expect((await library()).map((p: { id: string }) => p.id)).toEqual([second.id, first.id]);
	});

	it('gives displays shuffled ids with the timing, at most 200', async () => {
		expect(await listPhotos()).toEqual({ ids: [], timing: { idleMinutes: 5, slideSeconds: 30 } });
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) ids.push((await upload(file(png(i + 1, 1)))).id);
		expect([...(await listPhotos()).ids].sort()).toEqual([...ids].sort());
		expect(MAX_PHOTOS).toBe(200);
	});

	it('shuffles with the given random source', () => {
		const out = shuffle([1, 2, 3, 4, 5], () => 0);
		expect(out).toEqual([2, 3, 4, 5, 1]);
		expect([...out].sort()).toEqual([1, 2, 3, 4, 5]);
	});

	it('serves the stored bytes with the stored type', async () => {
		const bytes = webp('VP8X', 30, 25);
		const { id } = await upload(file(bytes));
		const res = await read(id);
		expect(res).toMatchObject({ contentType: 'image/webp', size: bytes.length });
		expect(res.bytes.equals(Buffer.from(bytes))).toBe(true);
	});

	it('answers not found for an unknown photo and refuses a malformed id', async () => {
		await expect(read('amb_photo_00000000-0000-7000-8000-000000000001')).rejects.toMatchObject({
			code: 'not_found',
		});
		expect(
			k.registry.routes
				.find((r) => r.route.operationId === 'ambient.getPhoto')
				?.route.params?.safeParse({ photoId: '../x' }).success,
		).toBe(false);
	});

	it('needs ambient.photos: a display may read, a member without it may not', async () => {
		const route = (id: string) => k.registry.routes.find((r) => r.route.operationId === id)?.route;
		expect(route('ambient.getPhoto')?.requires).toBe('ambient.photos');
		expect(route('ambient.listPhotos')?.requires).toBe('ambient.photos');
		expect(route('ambient.listLibrary')?.requires).toBe('ambient.manage');
		expect(route('ambient.uploadPhoto')?.requires).toBe('ambient.manage');
		expect(k.access.can(display(['ambient.photos']), 'ambient.photos')).toBe(true);
		expect(k.access.can(display(['ambient.weather']), 'ambient.photos')).toBe(false);
		expect(k.access.can(admin, 'ambient.photos')).toBe(true);
	});
});

describe('photo delete', () => {
	it('removes the row and the stored file, and is harmless a second time', async () => {
		const { id } = await upload(file(png()));
		const key = (
			await k.ctx.db
				.withTables<{ ambient_photos: { id: string; file_key: string } }>()
				.selectFrom('ambient_photos')
				.select('file_key')
				.executeTakeFirstOrThrow()
		).file_key;
		expect(await k.ctx.files.stat(key)).not.toBeNull();
		expect(await run('ambient.deletePhoto', { id })).toEqual({ removed: true });
		await k.worker.drain();
		expect(await k.ctx.files.stat(key)).toBeNull();
		expect(await library()).toEqual([]);
		await expect(read(id)).rejects.toMatchObject({ code: 'not_found' });
		expect(await run('ambient.deletePhoto', { id })).toEqual({ removed: false });
	});

	it('is for people who manage display content only', async () => {
		const { id } = await upload(file(png()));
		const child = (await k.member('supervised')).actor;
		await expect(k.runner.invoke('ambient.deletePhoto', { id }, child)).rejects.toMatchObject({
			code: 'forbidden',
		});
		await expect(
			k.runner.invoke('ambient.deletePhoto', { id }, display(['ambient.photos'])),
		).rejects.toBeDefined();
		expect(await library()).toHaveLength(1);
	});
});

describe('weather', () => {
	const place = { name: 'Istanbul, Türkiye', latitude: 41.01384, longitude: 28.94966 };
	const forecast = {
		current: { temperature_2m: 21.4, weather_code: 3 },
		daily: {
			temperature_2m_max: [24.1],
			temperature_2m_min: [16.2],
			precipitation_probability_max: [30],
		},
	};
	const url = forecastUrl({ ...place, latitude: 41.01, longitude: 28.95 });

	it('asks for Fahrenheit when the family chose it, and tells the display the unit', async () => {
		const f = forecastUrl({ ...place, latitude: 41.01, longitude: 28.95 }, 'fahrenheit');
		expect(f).toContain('temperature_unit=fahrenheit');
		expect(url).not.toContain('temperature_unit');
		await k.runner.invoke('core.updateFamilySettings', { temperatureUnit: 'fahrenheit' }, admin);
		await run('ambient.updateWeather', { enabled: true, place });
		k.http.serve(f, { text: JSON.stringify(forecast) });
		expect(await k.route('ambient.getWeather').call()).toMatchObject({
			forecast: { unit: 'fahrenheit', temperature: 21.4 },
		});
		expect(k.http.requests[0]?.url).toContain('temperature_unit=fahrenheit');
	});

	it('asks for is_day and turns it into isDay (day when it is missing)', async () => {
		expect(url).toContain('is_day');
		await run('ambient.updateWeather', { enabled: true, place });
		k.http.serve(url, {
			text: JSON.stringify({ ...forecast, current: { ...forecast.current, is_day: 0 } }),
		});
		expect(await k.route('ambient.getWeather').call()).toMatchObject({
			forecast: { isDay: false },
		});
		k.clock.advance(WEATHER_TTL_MS + 1);
		k.http.serve(url, { text: JSON.stringify(forecast) });
		expect(await k.route('ambient.getWeather').call()).toMatchObject({
			forecast: { isDay: true },
		});
	});

	it('is simply off by default', async () => {
		expect(await k.route('ambient.getWeather').call()).toMatchObject({
			enabled: false,
			forecast: null,
		});
		expect(k.http.requests).toEqual([]);
	});

	it('asks Open-Meteo for rounded coordinates and caches the answer for 30 minutes', async () => {
		await run('ambient.updateWeather', { enabled: true, place });
		expect(url).toContain('latitude=41.01&longitude=28.95');
		expect(url).toContain('forecast_days=2');
		k.http.serve(url, { text: JSON.stringify(forecast) });
		const first = await k.route('ambient.getWeather').call();
		expect(first).toMatchObject({
			enabled: true,
			forecast: {
				temperature: 21.4,
				weatherCode: 3,
				min: 16.2,
				max: 24.1,
				precipitationProbability: 30,
				place: 'Istanbul, Türkiye',
			},
		});
		await k.route('ambient.getWeather').call();
		expect(k.http.requests).toHaveLength(1);
		expect(k.http.requests[0]?.allowLocal).toBeFalsy();
		k.clock.advance(WEATHER_TTL_MS + 1);
		await k.route('ambient.getWeather').call();
		expect(k.http.requests).toHaveLength(2);
	});

	it('asks for two days of hours in the same call and keeps them as instants', async () => {
		expect(url).toContain('hourly=temperature_2m%2Cweather_code%2Cprecipitation_probability');
		expect(url).toContain('timeformat=unixtime');
		const hourly = {
			time: [1_791_500_400, 1_791_504_000, 1_791_507_600],
			temperature_2m: [14.2, null, 15.1],
			weather_code: [61, 3, 2],
			precipitation_probability: [70, 20, null],
		};
		await run('ambient.updateWeather', { enabled: true, place });
		k.http.serve(url, { text: JSON.stringify({ ...forecast, hourly }) });
		const { forecast: parsed } = (await k.route('ambient.getWeather').call()) as {
			forecast: { hourly: unknown[] };
		};
		// The hour without a temperature is left out.
		expect(parsed.hourly).toEqual([
			{ at: 1_791_500_400_000, temperature: 14.2, code: 61, precipitationProbability: 70 },
			{ at: 1_791_507_600_000, temperature: 15.1, code: 2, precipitationProbability: null },
		]);
	});

	it('reads an answer without hours, and a forecast cached before hours were fetched', () => {
		const parsed = parseForecast(JSON.stringify(forecast), place, 'celsius', 1);
		expect(parsed).toMatchObject({ temperature: 21.4, hourly: [] });
		expect(parseForecast('{"current":{}}', place, 'celsius', 1)).toBeNull();
		const { hourly: _hours, ...old } = parsed as NonNullable<typeof parsed>;
		expect(ForecastSchema.parse(old).hourly).toEqual([]);
	});

	it('reports an unreachable service as unavailable', async () => {
		await run('ambient.updateWeather', { enabled: true, place });
		await expect(k.route('ambient.getWeather').call()).rejects.toMatchObject({
			code: 'unavailable',
		});
	});

	it('waits at most a few seconds for the service, and remembers a failure for a minute', async () => {
		await run('ambient.updateWeather', { enabled: true, place });
		const weather = () => k.route('ambient.getWeather').call();
		await expect(weather()).rejects.toMatchObject({ code: 'unavailable' });
		await expect(weather()).rejects.toMatchObject({ code: 'unavailable' });
		await expect(weather()).rejects.toMatchObject({ code: 'unavailable' });
		// One call upstream, with a few seconds to answer, not fifteen.
		expect(k.http.requests).toHaveLength(1);
		expect(k.http.requests[0]?.timeoutMs).toBe(5_000);
		k.clock.advance(61_000);
		k.http.serve(url, { text: JSON.stringify(forecast) });
		expect(await weather()).toMatchObject({ enabled: true });
		expect(k.http.requests).toHaveLength(2);
	});

	it('searches places in the family language', async () => {
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ timeZone: 'Europe/Istanbul', locale: 'tr' },
			admin,
		);
		const search = 'https://geocoding-api.open-meteo.com/v1/search?name=Izmir&count=5&language=tr';
		k.http.serve(search, {
			text: JSON.stringify({
				results: [
					{
						name: 'İzmir',
						admin1: 'İzmir',
						country: 'Türkiye',
						latitude: 38.41273,
						longitude: 27.13838,
					},
				],
			}),
		});
		expect(await k.route('ambient.searchPlaces').call({ query: { q: 'Izmir' } })).toEqual([
			{ label: 'İzmir, İzmir, Türkiye', latitude: 38.41, longitude: 27.14 },
		]);
		k.http.serve(search, { text: '{}' });
		expect(await k.route('ambient.searchPlaces').call({ query: { q: 'Izmir' } })).toEqual([]);
	});
});

describe('capabilities', () => {
	it('declares photos and weather as view capabilities, so displays can be granted them', () => {
		const caps = k.registry.capabilities.filter((c) => c.id.startsWith('ambient.'));
		expect(caps.map((c) => [c.id, c.level])).toEqual([
			['ambient.photos', 'view'],
			['ambient.weather', 'view'],
			['ambient.manage', 'manage'],
		]);
	});

	it('lets a member manage only with the capability, and a display only what it was granted', async () => {
		const child = (await k.member('supervised')).actor;
		expect(k.access.can(admin, 'ambient.manage')).toBe(true);
		expect(k.access.can(child, 'ambient.manage')).toBe(false);
		const display = (caps: string[]) => ({
			kind: 'display' as const,
			deviceId: 'dev_1',
			capabilities: caps,
			showNames: false,
		});
		expect(k.access.can(display(['ambient.photos']), 'ambient.photos')).toBe(true);
		expect(k.access.can(display(['ambient.photos']), 'ambient.weather')).toBe(false);
		expect(k.access.can(display(['ambient.photos']), 'ambient.manage')).toBe(false);
		await expect(
			k.runner.invoke(
				'ambient.updateTiming',
				{ idleMinutes: 3, slideSeconds: 10 },
				display(['ambient.photos']),
			),
		).rejects.toBeDefined();
	});
});

describe('photo keys', () => {
	it('records only files the upload route stored, never another file', async () => {
		const stored = { type: 'image/png', width: 1, height: 1, size: 10 };
		for (const key of ['inbox/item_1/0', 'kitchen/recipes/r/p', 'ambient/photos/../x.png']) {
			await expect(run('ambient.addPhoto', { ...stored, key }), key).rejects.toBeTruthy();
		}
	});

	it('keeps one photo to a file and to the limits of the upload route', async () => {
		const stored = { type: 'image/png', width: 8, height: 6, size: 10 };
		const key = 'ambient/photos/amb_file_1.png';
		await run('ambient.addPhoto', { ...stored, key });
		await expect(run('ambient.addPhoto', { ...stored, key })).rejects.toBeTruthy();
		const other = 'ambient/photos/amb_file_2.png';
		for (const bad of [
			{ width: PHOTO_MAX_SIDE + 1 },
			{ height: PHOTO_MAX_SIDE + 1 },
			{ size: PHOTO_MAX_BYTES + 1 },
		])
			await expect(run('ambient.addPhoto', { ...stored, ...bad, key: other })).rejects.toBeTruthy();
	});
});
