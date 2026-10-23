import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Where the server's own `node:https` and DNS are pointed at the fake (see below). */
export const PRELOAD = new URL('./open-meteo-preload.ts', import.meta.url).pathname;

const HOUR = 3600;

/**
 * A stand-in for Open-Meteo's forecast: a mild, partly cloudy day. The server only reaches the
 * real service through `https`, so a run that wants weather loads `open-meteo-preload.ts` in the
 * server (`NODE_OPTIONS=--import …`, `FAMOS_FAKE_OPEN_METEO_PORT`), which sends those two hosts
 * here. Hours run from two days back to two days ahead, so any time of day has a forecast.
 */
export async function startFakeOpenMeteo() {
	const server = http.createServer((req, res) => {
		if (!req.url?.startsWith('/v1/forecast')) return void res.writeHead(404).end('{}');
		const first = Math.floor(Date.now() / 1000 / HOUR) * HOUR - 48 * HOUR;
		const time = Array.from({ length: 96 }, (_, i) => first + i * HOUR);
		// Warmest mid-afternoon (about 19 degrees), coolest before dawn (about 11).
		const temperature = time.map(
			(t) =>
				Math.round((15 + 4 * Math.sin(((((t / HOUR) % 24) - 9) / 24) * 2 * Math.PI)) * 10) / 10,
		);
		const body = {
			current: { temperature_2m: 18.5, weather_code: 2, is_day: 1 },
			daily: {
				temperature_2m_max: [19.2, 18.4],
				temperature_2m_min: [11.1, 10.6],
				precipitation_probability_max: [10, 20],
			},
			hourly: {
				time,
				temperature_2m: temperature,
				weather_code: time.map((t) => (((t / HOUR) % 24) % 7 < 3 ? 1 : 2)),
				precipitation_probability: time.map(() => 5),
			},
		};
		res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	server.unref();
	return { port: (server.address() as AddressInfo).port };
}
