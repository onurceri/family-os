import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, type BlockList as BlockListType, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
	type ExternalHttp,
	ExternalHttpError,
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

/** Whether an address may be contacted. IPv4-mapped IPv6 addresses are judged as IPv4. */
export function isAllowedAddress(address: string, allowLocal: boolean): boolean {
	const family = isIP(address);
	if (family === 0) return false;
	const kind = family === 4 ? 'ipv4' : 'ipv6';
	if (NEVER.check(address, kind)) return false;
	// NAT64 (64:ff9b::/96) and 6to4 forms embed an IPv4 address: judge the embedded one.
	const nat64 = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (nat64?.[1]) return isAllowedAddress(nat64[1], allowLocal);
	if (LOCAL.check(address, kind)) return allowLocal;
	return true;
}

/** Whether an address is on the family's own network (plain http is allowed only there). */
export function isLocalAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0) return false;
	const nat64 = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (nat64?.[1]) return isLocalAddress(nat64[1]);
	return LOCAL.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export type Resolver = (host: string) => Promise<string[]>;

export interface TransportRequest {
	url: URL;
	method: 'GET';
	/** The already checked address to connect to. */
	address: string;
	headers: Record<string, string>;
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
	return ({ url, method, address, headers, signal }) =>
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
			req.end();
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

	return {
		async get(request: ExternalHttpRequest): Promise<ExternalHttpResponse> {
			const allowLocal = request.allowLocal === true;
			let url = normalizeUrl(request.url, allowLocal);
			if (!url) throw new ExternalHttpError('bad_url', 'Only https: and webcal: addresses');
			const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
			const signal = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			const headers: Record<string, string> = {
				'user-agent': 'FamilyOS',
				accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5',
				'accept-encoding': 'gzip, deflate, br',
			};
			for (const [name, value] of Object.entries(request.headers ?? {}))
				if (name.toLowerCase() !== 'host') headers[name.toLowerCase()] = value;
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
					if (status === 304) {
						await discard(response.body);
						return { status: 304, etag, lastModified };
					}
					if (status !== 200) {
						await discard(response.body);
						throw new ExternalHttpError(`http_${status}`);
					}
					const declared = Number(response.headers['content-length']);
					if (!response.headers['content-encoding'] && declared > maxBytes)
						throw new ExternalHttpError('too_large', 'The response is too large');
					const body = await readCapped(response.body, maxBytes);
					const contentType = response.headers['content-type'] ?? null;
					const text = new TextDecoder('utf-8').decode(body);
					return { status: 200, text, contentType, etag, lastModified };
				}
			} catch (error) {
				if (isExternalHttpError(error)) throw error;
				if (isAbort(error) || signal.aborted) throw new ExternalHttpError('timeout', 'Timed out');
				throw new ExternalHttpError('unreachable', 'The request failed');
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
