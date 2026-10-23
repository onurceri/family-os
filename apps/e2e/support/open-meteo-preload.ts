import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

/**
 * Loaded into the server with `node --import` when `FAMOS_FAKE_OPEN_METEO_PORT` is set (see
 * fake-open-meteo.ts): Open-Meteo's two hosts resolve to a public address, so the guard lets the
 * request through, and the request itself goes to the fake on this machine.
 */
const port = process.env.FAMOS_FAKE_OPEN_METEO_PORT;
if (port) {
	const hosts = new Set(['api.open-meteo.com', 'geocoding-api.open-meteo.com']);
	const lookup = dns.lookup;
	dns.lookup = ((host: string, options: never) =>
		hosts.has(host)
			? Promise.resolve([{ address: '93.184.216.34', family: 4 }])
			: lookup(host, options)) as typeof dns.lookup;
	const request = https.request;
	https.request = ((options: https.RequestOptions, callback: never) => {
		if (typeof options.servername === 'string' && hosts.has(options.servername)) {
			const { servername: _, rejectUnauthorized: __, ...rest } = options;
			return http.request({ ...rest, host: '127.0.0.1', port: Number(port) }, callback);
		}
		return request(options, callback);
	}) as typeof https.request;
	syncBuiltinESMExports();
}
