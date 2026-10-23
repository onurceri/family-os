import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, type BlockList as BlockListType, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
	EXTERNAL_HTTP_MAX_POST_BYTES,
	type ExternalHttp,
	ExternalHttpError,
	type ExternalHttpPostRequest,
	type ExternalHttpPostResponse,
	type ExternalHttpRequest,
	type ExternalHttpResponse,
	isExternalHttpError,
} from '@famos/sdk';

/**
 * Guarded outbound HTTP. An address is checked after DNS resolution, and the connection
 * is made to that checked address (the host name is kept only for TLS and the Host header), so a
 * name that changes its answer between check and connect cannot reach a private address.
 */

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

function blockList(ranges: readonly [string, number, 'ipv4' | 'ipv6'][]): BlockListType {
	const list = new BlockList();
	for (const [net, prefix, family] of ranges) list.addSubnet(net, prefix, family);
	return list;
}

/** Never reachable, not even with `allowLocal`: unspecified, multicast, reserved, documentation. */
const NEVER = blockList([
	['0.0.0.0', 8, 'ipv4'],
	['192.0.0.0', 24, 'ipv4'],
	['192.0.2.0', 24, 'ipv4'],
	['198.18.0.0', 15, 'ipv4'],
	['198.51.100.0', 24, 'ipv4'],
	['203.0.113.0', 24, 'ipv4'],
	['224.0.0.0', 4, 'ipv4'],
	['240.0.0.0', 4, 'ipv4'],
	['::', 128, 'ipv6'],
	['ff00::', 8, 'ipv6'],
	['2001:db8::', 32, 'ipv6'],
	['100::', 64, 'ipv6'],
]);

/** The family's own network: private, loopback, link-local, unique-local, shared (CGNAT). */
const LOCAL = blockList([
	['10.0.0.0', 8, 'ipv4'],
	['100.64.0.0', 10, 'ipv4'],
	['127.0.0.0', 8, 'ipv4'],
	['169.254.0.0', 16, 'ipv4'],
	['172.16.0.0', 12, 'ipv4'],
	['192.168.0.0', 16, 'ipv4'],
	['::1', 128, 'ipv6'],
	['fc00::', 7, 'ipv6'],
	['fe80::', 10, 'ipv6'],
	['fec0::', 10, 'ipv6'],
]);

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
	if (isIP(address) !== 6) return null;
	let text = (address.split('%')[0] as string).toLowerCase();
	// A dotted IPv4 tail is two more groups.
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
	if (dotted) {
		const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
		text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head = '', tail, ...extra] = text.split('::');
	if (extra.length > 0) return null;
	const left = head === '' ? [] : head.split(':');
	const right = tail === undefined || tail === '' ? [] : tail.split(':');
	const fill = tail === undefined ? 0 : 8 - left.length - right.length;
	if (fill < 0 || (tail === undefined && left.length !== 8)) return null;
	const groups = [...left, ...Array<string>(fill).fill('0'), ...right].map((g) =>
		Number.parseInt(g, 16),
	);
	return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

const v4 = (a: number, b: number, c: number, d: number) => `${a}.${b}.${c}.${d}`;
const high = (g: number) => g >> 8;
const low = (g: number) => g & 0xff;

/**
 * The IPv4 address an IPv6 address carries, whatever way it is written: IPv4-mapped and
 * -compatible, NAT64 (64:ff9b::/96 and 64:ff9b:1::/48), 6to4 and Teredo (its client). Such an
 * address reaches that IPv4 host through a gateway, so it is judged as the IPv4 address.
 */
function embeddedIpv4(address: string): string | null {
	const g = ipv6Groups(address);
	if (!g) return null;
	const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const zeros = (to: number) => g.slice(0, to).every((x) => x === 0);
	// ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible); ::1 is the IPv6 loopback itself.
	if (zeros(5) && g5 === 0xffff) return v4(high(g6), low(g6), high(g7), low(g7));
	if (zeros(6) && !(g6 === 0 && g7 === 1)) return v4(high(g6), low(g6), high(g7), low(g7));
	if (g0 === 0x64 && g1 === 0xff9b) {
		if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
			return v4(high(g6), low(g6), high(g7), low(g7));
		// RFC 6052 /48: the address sits around the reserved octet at bits 64 to 71.
		if (g2 === 1) return v4(high(g3), low(g3), low(g4), high(g5));
	}
	if (g0 === 0x2002) return v4(high(g1), low(g1), high(g2), low(g2));
	// Teredo keeps the client's address inverted in the last 32 bits.
	if (g0 === 0x2001 && g1 === 0)
		return v4(high(g6) ^ 0xff, low(g6) ^ 0xff, high(g7) ^ 0xff, low(g7) ^ 0xff);
	return null;
}

/** Whether an address may be contacted. IPv6 forms that carry an IPv4 address are judged as that IPv4 address. */
export function isAllowedAddress(address: string, allowLocal: boolean): boolean {
	const family = isIP(address);
	if (family === 0) return false;
	const embedded = family === 6 ? embeddedIpv4(address) : null;
	if (embedded) return isAllowedAddress(embedded, allowLocal);
	const kind = family === 4 ? 'ipv4' : 'ipv6';
	// The bare address, without a zone, so the lists see the same text as the parser.
	const bare = address.split('%')[0] as string;
	if (NEVER.check(bare, kind)) return false;
	if (LOCAL.check(bare, kind)) return allowLocal;
	return true;
}

/** Whether an address is on the family's own network (plain http is allowed only there). */
export function isLocalAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0) return false;
	const embedded = family === 6 ? embeddedIpv4(address) : null;
	if (embedded) return isLocalAddress(embedded);
	return LOCAL.check(address.split('%')[0] as string, family === 4 ? 'ipv4' : 'ipv6');
}

export type Resolver = (host: string) => Promise<string[]>;

export interface TransportRequest {
	url: URL;
	method: 'GET' | 'POST';
	/** The already checked address to connect to. */
	address: string;
	headers: Record<string, string>;
	/** A POST's body, already serialized. */
	body?: Uint8Array;
	signal: AbortSignal;
}

export interface TransportResponse {
	status: number;
	headers: Record<string, string | undefined>;
	/** Decoded (decompressed) body. */
	body: AsyncIterable<Uint8Array>;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export const defaultResolver: Resolver = async (host) =>
	(await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** HTTPS over `node:https` (plain `node:http` for `http:` addresses), connected to a given address. `rejectUnauthorized: false` is for tests. */
export function createNodeTransport(options: { rejectUnauthorized?: boolean } = {}): Transport {
	return ({ url, method, address, headers, body: payload, signal }) =>
		new Promise((resolve, reject) => {
			const request = url.protocol === 'http:' ? httpRequest : httpsRequest;
			const req = request(
				{
					host: address,
					port: url.port || (url.protocol === 'http:' ? 80 : 443),
					path: `${url.pathname}${url.search}`,
					method,
					servername: url.hostname,
					headers: { ...headers, host: url.host },
					signal,
					rejectUnauthorized: options.rejectUnauthorized ?? true,
				},
				(res) => {
					const out: Record<string, string | undefined> = {};
					for (const [k, v] of Object.entries(res.headers))
						out[k] = Array.isArray(v) ? v.join(', ') : v;
					const encoding = out['content-encoding']?.toLowerCase();
					const decoder =
						encoding === 'gzip' || encoding === 'x-gzip'
							? createGunzip()
							: encoding === 'deflate'
								? createInflate()
								: encoding === 'br'
									? createBrotliDecompress()
									: null;
					const body = decoder ? res.pipe(decoder) : res;
					if (decoder) res.on('error', (error) => decoder.destroy(error));
					resolve({ status: res.statusCode ?? 0, headers: out, body });
				},
			);
			req.on('error', reject);
			req.end(payload);
		});
}

export interface GuardedHttpOptions {
	/** DNS resolution (inject in tests). */
	resolve?: Resolver;
	transport?: Transport;
}

/** `webcal:` is `https:`. Returns null for anything else a feed may not use. */
export function normalizeFeedUrl(raw: string): URL | null {
	let url: URL;
	try {
		url = new URL(raw.trim().replace(/^webcals?:/i, 'https:'));
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
	return url;
}

/** Like `normalizeFeedUrl`, but `http:` is accepted when the caller allows local addresses. */
export function normalizeUrl(raw: string, allowLocal: boolean): URL | null {
	const url = normalizeFeedUrl(raw);
	if (url) return url;
	let plain: URL;
	try {
		plain = new URL(raw.trim());
	} catch {
		return null;
	}
	if (!allowLocal || plain.protocol !== 'http:' || plain.username || plain.password) return null;
	return plain.hostname ? plain : null;
}

const isAbort = (error: unknown) =>
	error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

export function createGuardedHttp(options: GuardedHttpOptions = {}): ExternalHttp {
	const resolve = options.resolve ?? defaultResolver;
	const transport = options.transport ?? createNodeTransport();

	/** Resolves a host and returns an address that may be contacted. */
	async function pick(host: string, allowLocal: boolean, plainHttp = false): Promise<string> {
		const bare = host.replace(/^\[|\]$/g, '');
		let addresses: string[];
		try {
			addresses = isIP(bare) ? [bare] : await resolve(bare);
		} catch {
			throw new ExternalHttpError('unreachable', 'DNS lookup failed');
		}
		if (addresses.length === 0) throw new ExternalHttpError('unreachable', 'DNS lookup failed');
		// Every answer must be allowed: a name that also points inside is refused outright.
		if (!addresses.every((a) => isAllowedAddress(a, allowLocal)))
			throw new ExternalHttpError('blocked_address', 'The address is not allowed');
		// Unencrypted requests (and the keys they carry) never leave the local network.
		if (plainHttp && !addresses.every(isLocalAddress))
			throw new ExternalHttpError(
				'blocked_address',
				'Plain http is allowed only on the local network',
			);
		return addresses[0] as string;
	}

	/** The checked URL, the headers every request sends and the deadline of one request. */
	function prepare(request: ExternalHttpRequest | ExternalHttpPostRequest, accept: string) {
		const allowLocal = request.allowLocal === true;
		const url = normalizeUrl(request.url, allowLocal);
		if (!url) throw new ExternalHttpError('bad_url', 'Only https: and webcal: addresses');
		const headers: Record<string, string> = {
			'user-agent': 'FamilyOS',
			accept,
			'accept-encoding': 'gzip, deflate, br',
		};
		for (const [name, value] of Object.entries(request.headers ?? {}))
			if (name.toLowerCase() !== 'host') headers[name.toLowerCase()] = value;
		return {
			url,
			allowLocal,
			headers,
			maxBytes: request.maxBytes ?? DEFAULT_MAX_BYTES,
			signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		};
	}

	/** An error of the transport, in the port's words. */
	function failure(error: unknown, signal: AbortSignal): ExternalHttpError {
		if (isExternalHttpError(error)) return error;
		if (isAbort(error) || signal.aborted) return new ExternalHttpError('timeout', 'Timed out');
		return new ExternalHttpError('unreachable', 'The request failed');
	}

	async function readBody(response: TransportResponse, maxBytes: number): Promise<string> {
		const declared = Number(response.headers['content-length']);
		if (!response.headers['content-encoding'] && declared > maxBytes) {
			await discard(response.body);
			throw new ExternalHttpError('too_large', 'The response is too large');
		}
		return new TextDecoder('utf-8').decode(await readCapped(response.body, maxBytes));
	}

	return {
		async get(request: ExternalHttpRequest): Promise<ExternalHttpResponse> {
			const prepared = prepare(request, 'text/calendar, text/plain;q=0.8, */*;q=0.5');
			const { allowLocal, headers, maxBytes, signal } = prepared;
			let { url } = prepared;
			if (request.conditional?.etag) headers['if-none-match'] = request.conditional.etag;
			if (request.conditional?.lastModified)
				headers['if-modified-since'] = request.conditional.lastModified;
			const originHost = url.hostname.toLowerCase();

			try {
				for (let hop = 0; ; hop++) {
					const address = await pick(url.hostname, allowLocal, url.protocol === 'http:');
					const response = await transport({ url, method: 'GET', address, headers, signal });
					const { status } = response;
					if (status >= 300 && status < 400 && status !== 304) {
						await discard(response.body);
						if (request.redirects === 'none')
							throw new ExternalHttpError('redirect_refused', 'Redirects are not followed');
						const location = response.headers.location;
						if (!location || hop >= MAX_REDIRECTS)
							throw new ExternalHttpError('redirect_refused', 'Too many or empty redirects');
						const next = normalizeUrl(new URL(location, url).toString(), allowLocal);
						if (!next || next.hostname.toLowerCase() !== originHost)
							throw new ExternalHttpError('redirect_refused', 'Redirect to another host');
						url = next;
						continue;
					}
					const etag = response.headers.etag ?? null;
					const lastModified = response.headers['last-modified'] ?? null;
					const cacheControl = response.headers['cache-control'] ?? null;
					if (status === 304) {
						await discard(response.body);
						return { status: 304, etag, lastModified, cacheControl };
					}
					if (status !== 200) {
						await discard(response.body);
						throw new ExternalHttpError(`http_${status}`);
					}
					const text = await readBody(response, maxBytes);
					const contentType = response.headers['content-type'] ?? null;
					return { status: 200, text, contentType, etag, lastModified, cacheControl };
				}
			} catch (error) {
				throw failure(error, signal);
			}
		},

		async post(request: ExternalHttpPostRequest): Promise<ExternalHttpPostResponse> {
			const { url, allowLocal, headers, maxBytes, signal } = prepare(
				request,
				'application/json, text/plain;q=0.8, */*;q=0.5',
			);
			// A body that is not JSON (undefined, a function, a BigInt) is the caller's mistake.
			const serialized: string | undefined = JSON.stringify(request.json);
			if (serialized === undefined) throw new TypeError('The body cannot be sent as JSON');
			const body = new TextEncoder().encode(serialized);
			if (body.byteLength > EXTERNAL_HTTP_MAX_POST_BYTES)
				throw new ExternalHttpError('too_large', 'The request body is too large');
			headers['content-type'] = 'application/json';
			headers['content-length'] = String(body.byteLength);

			try {
				const address = await pick(url.hostname, allowLocal, url.protocol === 'http:');
				const response = await transport({ url, method: 'POST', address, headers, body, signal });
				const { status } = response;
				// Never sent again, to this host or another: the change may already have happened.
				if (status >= 300 && status < 400) {
					await discard(response.body);
					throw new ExternalHttpError('redirect_refused', 'A POST is not redirected');
				}
				if (status < 200 || status >= 300) {
					await discard(response.body);
					throw new ExternalHttpError(`http_${status}`);
				}
				return { status, text: await readBody(response, maxBytes) };
			} catch (error) {
				throw failure(error, signal);
			}
		},
	};
}

async function discard(body: AsyncIterable<Uint8Array>): Promise<void> {
	try {
		// Not worth reading: stop the stream.
		const iterator = body[Symbol.asyncIterator]();
		await iterator.return?.();
	} catch {
		// Already closed.
	}
}

async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		size += chunk.byteLength;
		if (size > maxBytes) {
			await discard(body);
			throw new ExternalHttpError('too_large', 'The response is too large');
		}
		chunks.push(chunk);
	}
	const joined = Buffer.concat(chunks);
	return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
}
