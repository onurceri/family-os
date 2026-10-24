import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { isExternalHttpError } from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import {
	createGuardedHttp,
	createNodeTransport,
	isAllowedAddress,
	isLocalAddress,
	normalizeFeedUrl,
	type Transport,
	type TransportRequest,
	type TransportResponse,
} from '../src/http-guard/index.ts';

const stream = async function* (text: string): AsyncGenerator<Uint8Array> {
	yield new TextEncoder().encode(text);
};

/** A transport that answers from a script and records what it was asked. */
function scripted(...answers: (Partial<TransportResponse> & { text?: string })[]) {
	const requests: TransportRequest[] = [];
	const transport: Transport = async (request) => {
		requests.push(request);
		const next = answers.shift() ?? { status: 200, text: '' };
		return {
			status: next.status ?? 200,
			headers: next.headers ?? {},
			body: next.body ?? stream(next.text ?? ''),
		};
	};
	return { transport, requests };
}

const dns =
	(table: Record<string, string[]>) =>
	async (host: string): Promise<string[]> => {
		const found = table[host];
		if (!found) throw new Error('ENOTFOUND');
		return found;
	};

const code = async (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(e: unknown) => (isExternalHttpError(e) ? e.code : `other:${String(e)}`),
	);

describe('addresses', () => {
	it.each([
		'10.1.2.3',
		'127.0.0.1',
		'169.254.169.254',
		'172.16.0.1',
		'172.31.255.255',
		'192.168.1.10',
		'100.64.0.1',
		'::1',
		'fe80::1',
		'fd12:3456::1',
		'::ffff:127.0.0.1',
		'::ffff:7f00:1',
		'64:ff9b::10.0.0.1',
	])('%s is local', (address) => {
		expect(isAllowedAddress(address, false)).toBe(false);
		expect(isAllowedAddress(address, true)).toBe(true);
	});

	it.each(['0.0.0.0', '224.0.0.1', '239.255.255.250', '255.255.255.255', '::', 'ff02::1', 'nope'])(
		'%s is never allowed',
		(address) => {
			expect(isAllowedAddress(address, false)).toBe(false);
			expect(isAllowedAddress(address, true)).toBe(false);
		},
	);

	it.each(['8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '64:ff9b::8.8.8.8'])(
		'%s is public',
		(address) => expect(isAllowedAddress(address, false)).toBe(true),
	);
});

describe('addresses that carry an IPv4 address', () => {
	// [form, private, public], each written in hex and in dotted notation where both exist.
	const forms: [string, string, string][] = [
		['mapped hex', '::ffff:a00:1', '::ffff:808:808'],
		['mapped dotted', '::ffff:10.0.0.1', '::ffff:8.8.8.8'],
		['mapped, long', '0:0:0:0:0:ffff:c0a8:101', '0:0:0:0:0:ffff:808:808'],
		['compatible hex', '::a00:1', '::808:808'],
		['compatible dotted', '::10.0.0.1', '::8.8.8.8'],
		['NAT64 hex', '64:ff9b::a00:1', '64:ff9b::808:808'],
		['NAT64 dotted', '64:ff9b::10.0.0.1', '64:ff9b::8.8.8.8'],
		['NAT64 expanded', '0064:ff9b:0:0:0:0:7f00:1', '0064:ff9b:0:0:0:0:808:808'],
		['NAT64 local-use /48', '64:ff9b:1:a00:1:0:0:0', '64:ff9b:1:808:8:800:0:0'],
		['6to4', '2002:a00:1::', '2002:808:808::'],
		['6to4 with a host part', '2002:c0a8:101:1::1', '2002:808:808:1::1'],
		['Teredo', '2001:0:4136:e378:8000:63bf:f5ff:fffe', '2001:0:4136:e378:8000:63bf:f7f7:f7f7'],
		['uppercase', '::FFFF:A00:1', '::FFFF:808:808'],
	];
	it.each(forms)('%s: a private client is local', (_name, local) => {
		expect(isAllowedAddress(local, false)).toBe(false);
		expect(isAllowedAddress(local, true)).toBe(true);
		expect(isLocalAddress(local)).toBe(true);
	});
	it.each(forms)('%s: a public client is allowed', (_name, _local, pub) => {
		expect(isAllowedAddress(pub, false)).toBe(true);
		expect(isLocalAddress(pub)).toBe(false);
	});
	it('never allows an embedded address that is never reachable', () => {
		for (const address of ['::ffff:0:1', '64:ff9b::e000:1', '2002:e000:1::']) {
			expect(isAllowedAddress(address, true)).toBe(false);
		}
	});
	it('keeps the IPv6 loopback local and judges literal hosts and DNS answers alike', async () => {
		expect(isAllowedAddress('::1', false)).toBe(false);
		expect(isAllowedAddress('::1', true)).toBe(true);
		const transport = async () => ({
			status: 200,
			headers: {},
			body: (async function* () {
				yield new TextEncoder().encode('ok');
			})(),
		});
		const http = createGuardedHttp({
			transport,
			resolve: async (host) =>
				host === 'sneaky.example' ? ['64:ff9b::a00:1'] : ['2002:808:808::'],
		});
		for (const url of [
			'https://[::ffff:a00:1]/',
			'https://[64:ff9b::a00:1]/',
			'https://sneaky.example/',
		])
			await expect(http.get({ url })).rejects.toMatchObject({ code: 'blocked_address' });
		await expect(http.get({ url: 'https://[2002:808:808::]/' })).resolves.toMatchObject({
			status: 200,
		});
		await expect(http.get({ url: 'https://public.example/' })).resolves.toMatchObject({
			status: 200,
		});
	});
});

describe('urls', () => {
	it('maps webcal to https and refuses everything else', () => {
		expect(normalizeFeedUrl('webcal://example.org/a.ics')?.toString()).toBe(
			'https://example.org/a.ics',
		);
		expect(normalizeFeedUrl('https://example.org/a.ics')).not.toBeNull();
		expect(normalizeFeedUrl('http://example.org/a.ics')).toBeNull();
		expect(normalizeFeedUrl('ftp://example.org/a.ics')).toBeNull();
		expect(normalizeFeedUrl('https://user:pw@example.org/a.ics')).toBeNull();
		expect(normalizeFeedUrl('not a url')).toBeNull();
	});
});

describe('guarded get', () => {
	const resolve = dns({
		'cal.example.org': ['93.184.216.34'],
		'nas.home': ['192.168.1.5'],
		'sneaky.example.org': ['93.184.216.34', '10.0.0.7'],
		'v6.example.org': ['fd00::5'],
		'localhost.example.org': ['127.0.0.1'],
	});

	it('fetches over https from the checked address and returns validators', async () => {
		const { transport, requests } = scripted({
			headers: {
				etag: '"abc"',
				'last-modified': 'Mon, 05 Oct 2026 08:00:00 GMT',
				'cache-control': 'max-age=60',
			},
			text: 'BEGIN:VCALENDAR',
		});
		const http = createGuardedHttp({ resolve, transport });
		const result = await http.get({ url: 'webcal://cal.example.org/a.ics?key=1' });
		expect(result).toEqual({
			status: 200,
			text: 'BEGIN:VCALENDAR',
			contentType: null,
			etag: '"abc"',
			lastModified: 'Mon, 05 Oct 2026 08:00:00 GMT',
			cacheControl: 'max-age=60',
		});
		expect(requests[0]?.address).toBe('93.184.216.34');
		expect(requests[0]?.url.toString()).toBe('https://cal.example.org/a.ics?key=1');
	});

	it('sends conditional headers and understands 304', async () => {
		const { transport, requests } = scripted({ status: 304, headers: { etag: '"abc"' } });
		const http = createGuardedHttp({ resolve, transport });
		const result = await http.get({
			url: 'https://cal.example.org/a.ics',
			conditional: { etag: '"abc"', lastModified: 'Mon, 05 Oct 2026 08:00:00 GMT' },
		});
		expect(result.status).toBe(304);
		expect(requests[0]?.headers['if-none-match']).toBe('"abc"');
		expect(requests[0]?.headers['if-modified-since']).toBe('Mon, 05 Oct 2026 08:00:00 GMT');
	});

	it('refuses private names, literal addresses and mixed answers', async () => {
		const { transport, requests } = scripted();
		const http = createGuardedHttp({ resolve, transport });
		for (const host of [
			'nas.home',
			'sneaky.example.org',
			'v6.example.org',
			'localhost.example.org',
			'127.0.0.1',
			'[::1]',
			'169.254.169.254',
		]) {
			expect(await code(http.get({ url: `https://${host}/a.ics` }))).toBe('blocked_address');
		}
		expect(requests).toHaveLength(0);
	});

	it('allows the local network when asked, but still not a mixed-in unspecified address', async () => {
		const { transport, requests } = scripted({ text: 'x' });
		const http = createGuardedHttp({ resolve, transport });
		const result = await http.get({ url: 'https://nas.home/a.ics', allowLocal: true });
		expect(result.status).toBe(200);
		expect(requests[0]?.address).toBe('192.168.1.5');
		expect(await code(http.get({ url: 'https://0.0.0.0/a.ics', allowLocal: true }))).toBe(
			'blocked_address',
		);
	});

	it('refuses plain http and unknown hosts', async () => {
		const http = createGuardedHttp({ resolve, transport: scripted().transport });
		expect(await code(http.get({ url: 'http://cal.example.org/a.ics' }))).toBe('bad_url');
		expect(await code(http.get({ url: 'https://missing.example.org/a.ics' }))).toBe('unreachable');
	});

	it('follows redirects on the same host and checks the target again', async () => {
		const { transport, requests } = scripted(
			{ status: 302, headers: { location: '/moved.ics' } },
			{ text: 'ok' },
		);
		const http = createGuardedHttp({ resolve, transport });
		expect((await http.get({ url: 'https://cal.example.org/a.ics' })).status).toBe(200);
		expect(requests.map((r) => r.url.pathname)).toEqual(['/a.ics', '/moved.ics']);
	});

	it('refuses every redirect, even on the same host, when asked to', async () => {
		const { transport, requests } = scripted(
			{ status: 302, headers: { location: '/moved.json' } },
			{ text: 'never read' },
		);
		const http = createGuardedHttp({ resolve, transport });
		expect(await code(http.get({ url: 'https://cal.example.org/a.json', redirects: 'none' }))).toBe(
			'redirect_refused',
		);
		expect(requests).toHaveLength(1);
	});

	it('refuses redirects to another host, to http and endless chains', async () => {
		const other = createGuardedHttp({
			resolve,
			transport: scripted({ status: 301, headers: { location: 'https://nas.home/a.ics' } })
				.transport,
		});
		expect(await code(other.get({ url: 'https://cal.example.org/a.ics' }))).toBe(
			'redirect_refused',
		);
		const plain = createGuardedHttp({
			resolve,
			transport: scripted({ status: 301, headers: { location: 'http://cal.example.org/a.ics' } })
				.transport,
		});
		expect(await code(plain.get({ url: 'https://cal.example.org/a.ics' }))).toBe(
			'redirect_refused',
		);
		const loop: Transport = async () => ({
			status: 302,
			headers: { location: '/again.ics' },
			body: stream(''),
		});
		const endless = createGuardedHttp({ resolve, transport: loop });
		expect(await code(endless.get({ url: 'https://cal.example.org/a.ics' }))).toBe(
			'redirect_refused',
		);
	});

	it('enforces the size cap, declared and streamed', async () => {
		const declared = createGuardedHttp({
			resolve,
			transport: scripted({ headers: { 'content-length': '999' }, text: 'x' }).transport,
		});
		expect(await code(declared.get({ url: 'https://cal.example.org/a', maxBytes: 100 }))).toBe(
			'too_large',
		);
		const streamed = createGuardedHttp({
			resolve,
			transport: scripted({ text: 'x'.repeat(200) }).transport,
		});
		expect(await code(streamed.get({ url: 'https://cal.example.org/a', maxBytes: 100 }))).toBe(
			'too_large',
		);
	});

	it('reports other statuses and a timeout', async () => {
		const http = createGuardedHttp({ resolve, transport: scripted({ status: 404 }).transport });
		expect(await code(http.get({ url: 'https://cal.example.org/a.ics' }))).toBe('http_404');
		const hang: Transport = ({ signal }) =>
			new Promise((_, reject) =>
				signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted'))),
			);
		const slow = createGuardedHttp({ resolve, transport: hang });
		expect(await code(slow.get({ url: 'https://cal.example.org/a.ics', timeoutMs: 30 }))).toBe(
			'timeout',
		);
	});
});

/** The real transport, against a local TLS server with a throwaway certificate. */
const hasOpenssl = (() => {
	try {
		execFileSync('openssl', ['version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!hasOpenssl)('node transport', () => {
	it('connects to the given address, sends the host name, decompresses and caps', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'famos-tls-'));
		execFileSync(
			'openssl',
			[
				'req',
				'-x509',
				// An EC key generates instantly; RSA key generation takes a random, load-dependent time.
				'-newkey',
				'ec',
				'-pkeyopt',
				'ec_paramgen_curve:prime256v1',
				'-nodes',
				'-days',
				'1',
				'-subj',
				'/CN=cal.example.org',
				'-keyout',
				join(dir, 'k.pem'),
				'-out',
				join(dir, 'c.pem'),
			],
			{ stdio: 'ignore' },
		);
		const seen: { host?: string | undefined }[] = [];
		const server = createServer(
			{ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) },
			(req, res) => {
				seen.push({ host: req.headers.host });
				res.setHeader('etag', '"v1"');
				if (req.url === '/big.ics') {
					res.setHeader('content-encoding', 'gzip');
					res.end(gzipSync('x'.repeat(10_000)));
				} else {
					res.setHeader('content-encoding', 'gzip');
					res.end(gzipSync('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'));
				}
			},
		);
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address() as AddressInfo;
		try {
			const http = createGuardedHttp({
				resolve: dns({ 'cal.example.org': ['127.0.0.1'] }),
				transport: createNodeTransport({ rejectUnauthorized: false }),
			});
			const result = await http.get({
				url: `https://cal.example.org:${port}/a.ics`,
				allowLocal: true,
			});
			expect(result).toMatchObject({ status: 200, etag: '"v1"' });
			expect((result as { text: string }).text).toContain('BEGIN:VCALENDAR');
			expect(seen[0]?.host).toBe(`cal.example.org:${port}`);
			expect(
				await code(
					http.get({
						url: `https://cal.example.org:${port}/big.ics`,
						allowLocal: true,
						maxBytes: 1000,
					}),
				),
			).toBe('too_large');
		} finally {
			server.close();
		}
	});
});

describe('headers and plain http (a service on the home network)', () => {
	const resolve = dns({ 'nas.lan': ['192.168.1.20'], 'photos.example': ['93.184.216.34'] });

	it('sends extra headers and reports the content type', async () => {
		const { transport, requests } = scripted({
			headers: { 'content-type': 'image/jpeg' },
			body: (async function* () {
				yield new Uint8Array([1, 2, 3]);
			})(),
		});
		const http = createGuardedHttp({ resolve, transport });
		const response = await http.get({
			url: 'http://nas.lan:2283/api/assets/x/thumb',
			allowLocal: true,
			headers: { 'X-Api-Key': 'k', host: 'evil.example', accept: 'image/*' },
		});
		expect(response).toMatchObject({ status: 200, contentType: 'image/jpeg' });
		expect(requests[0]?.headers).toMatchObject({ 'x-api-key': 'k', accept: 'image/*' });
		expect(requests[0]?.headers.host).toBeUndefined();
	});

	it('accepts http: only for local addresses that are allowed', async () => {
		const http = createGuardedHttp({ resolve, transport: scripted({ text: 'ok' }).transport });
		expect(await code(http.get({ url: 'http://nas.lan/x' }))).toBe('bad_url');
		expect(await code(http.get({ url: 'http://photos.example/x' }))).toBe('bad_url');
		expect(await code(http.get({ url: 'http://nas.lan/x', allowLocal: true }))).toBeNull();
		// Plain http never goes to a public address, even when local ones are allowed (keys in clear).
		expect(await code(http.get({ url: 'http://photos.example/x', allowLocal: true }))).toBe(
			'blocked_address',
		);
		// Allowing local addresses never lets a public name resolve to a private address through.
		expect(await code(http.get({ url: 'http://user:pw@nas.lan/x', allowLocal: true }))).toBe(
			'bad_url',
		);
	});
});

describe('guarded post', () => {
	const resolve = dns({
		'ha.example.org': ['93.184.216.34'],
		'ha.lan': ['192.168.1.20'],
		'sneaky.example.org': ['93.184.216.34', '10.0.0.7'],
	});
	const body = (request: TransportRequest | undefined) =>
		new TextDecoder().decode(request?.body ?? new Uint8Array());

	it('sends the body as JSON to the checked address and returns the answer', async () => {
		const { transport, requests } = scripted({ status: 200, text: '[]' });
		const http = createGuardedHttp({ resolve, transport });
		const result = await http.post({
			url: 'https://ha.example.org/api/services/light/turn_on',
			json: { entity_id: 'light.kitchen' },
			headers: { authorization: 'Bearer t' },
		});
		expect(result).toEqual({ status: 200, text: '[]' });
		expect(requests[0]).toMatchObject({ method: 'POST', address: '93.184.216.34' });
		expect(requests[0]?.headers).toMatchObject({
			'content-type': 'application/json',
			'content-length': '29',
			authorization: 'Bearer t',
		});
		expect(body(requests[0])).toBe('{"entity_id":"light.kitchen"}');
	});

	it('refuses blocked addresses, and reaches the home network only with allowLocal', async () => {
		const { transport, requests } = scripted({ status: 200 });
		const http = createGuardedHttp({ resolve, transport });
		for (const url of [
			'https://sneaky.example.org/x',
			'https://169.254.169.254/x',
			'https://ha.lan/x',
			'https://127.0.0.1/x',
		])
			expect(await code(http.post({ url, json: {} }))).toBe('blocked_address');
		expect(await code(http.post({ url: 'http://ha.lan:8123/x', json: {} }))).toBe('bad_url');
		expect(await code(http.post({ url: 'https://0.0.0.0/x', json: {}, allowLocal: true }))).toBe(
			'blocked_address',
		);
		// Plain http never leaves the home network, even when it is allowed.
		expect(
			await code(http.post({ url: 'http://ha.example.org/x', json: {}, allowLocal: true })),
		).toBe('blocked_address');
		expect(requests).toHaveLength(0);
		expect(await http.post({ url: 'http://ha.lan:8123/x', json: {}, allowLocal: true })).toEqual({
			status: 200,
			text: '',
		});
		expect(requests[0]?.address).toBe('192.168.1.20');
	});

	it('never follows a redirect, not even on the same host', async () => {
		const { transport, requests } = scripted(
			{ status: 307, headers: { location: '/api/again' } },
			{ status: 200 },
		);
		const http = createGuardedHttp({ resolve, transport });
		expect(await code(http.post({ url: 'https://ha.example.org/api', json: {} }))).toBe(
			'redirect_refused',
		);
		expect(requests).toHaveLength(1);
	});

	it('refuses a body over 64 KB before sending anything', async () => {
		const { transport, requests } = scripted();
		const http = createGuardedHttp({ resolve, transport });
		expect(
			await code(http.post({ url: 'https://ha.example.org/x', json: { a: 'x'.repeat(70_000) } })),
		).toBe('too_large');
		await expect(http.post({ url: 'https://ha.example.org/x', json: undefined })).rejects.toThrow(
			TypeError,
		);
		expect(requests).toHaveLength(0);
	});

	it('caps the answer, reports other statuses and a timeout', async () => {
		const big = createGuardedHttp({
			resolve,
			transport: scripted({ text: 'x'.repeat(200) }).transport,
		});
		expect(await code(big.post({ url: 'https://ha.example.org/x', json: {}, maxBytes: 100 }))).toBe(
			'too_large',
		);
		const refused = createGuardedHttp({ resolve, transport: scripted({ status: 400 }).transport });
		expect(await code(refused.post({ url: 'https://ha.example.org/x', json: {} }))).toBe(
			'http_400',
		);
		const hang: Transport = ({ signal }) =>
			new Promise((_, reject) =>
				signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted'))),
			);
		const slow = createGuardedHttp({ resolve, transport: hang });
		expect(
			await code(slow.post({ url: 'https://ha.example.org/x', json: {}, timeoutMs: 30 })),
		).toBe('timeout');
	});
});

describe('node transport, post', () => {
	it('sends the body and its length to a service on the home network', async () => {
		const seen: { method?: string; type?: string; body: string }[] = [];
		const server = createHttpServer((req, res) => {
			let body = '';
			req.on('data', (chunk: Buffer) => {
				body += chunk.toString('utf8');
			});
			req.on('end', () => {
				seen.push({ method: req.method, type: req.headers['content-type'], body });
				res.setHeader('content-type', 'application/json');
				res.end('[]');
			});
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address() as AddressInfo;
		try {
			const http = createGuardedHttp({ transport: createNodeTransport() });
			const result = await http.post({
				url: `http://127.0.0.1:${port}/api/services/light/turn_on`,
				json: { entity_id: 'light.kitchen' },
				allowLocal: true,
			});
			expect(result).toEqual({ status: 200, text: '[]' });
			expect(seen).toEqual([
				{ method: 'POST', type: 'application/json', body: '{"entity_id":"light.kitchen"}' },
			]);
		} finally {
			server.close();
		}
	});
});

describe('a request that is told to stop', () => {
	it('ends with a timeout when the caller aborts, whatever its own limit', async () => {
		const resolve = dns({ 'cal.example.org': ['93.184.216.34'] });
		let seen: AbortSignal | undefined;
		// A server that never answers: it ends only with the request's signal.
		const transport: Transport = (request) =>
			new Promise((_, reject) => {
				seen = request.signal;
				request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
					once: true,
				});
			});
		const http = createGuardedHttp({ resolve, transport });
		const stop = new AbortController();
		const get = code(
			http.get({ url: 'https://cal.example.org/a.ics', timeoutMs: 60_000, signal: stop.signal }),
		);
		const post = code(
			http.post({
				url: 'https://cal.example.org/hook',
				json: {},
				timeoutMs: 60_000,
				signal: stop.signal,
			}),
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(seen?.aborted).toBe(false);
		stop.abort();
		expect(await get).toBe('timeout');
		expect(await post).toBe('timeout');
	});
});
