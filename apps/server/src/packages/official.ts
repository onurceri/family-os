import { createHash, verify } from 'node:crypto';
import type { IndexedPackage, IndexReach } from '@famos/core';
import { type ExtensionManifest, FamosError, isFamosError } from '@famos/sdk';
import { z } from 'zod';
import { ARCHIVE_LIMITS } from './archive.ts';
import { publicKeyOf, type TrustRoot } from './trust.ts';
import { SignatureSchema } from './verify.ts';

/**
 * The official index of extension packages, on the project's GitHub Pages, next to its
 * signature (`index.json.sig`). It is read only when a person presses "Look for more".
 */
export const OFFICIAL_INDEX_URL = 'https://onurceri.github.io/family-os/extensions/index.json';

/** The most the index, its signature and a package may weigh, and how long each may take. */
export const INDEX_LIMITS = {
	indexBytes: 1024 * 1024,
	signatureBytes: 4 * 1024,
	indexMs: 20_000,
	packageMs: 150_000,
} as const;

/** What `fetch` the index is read with: the platform's, or a fake in tests. */
export type Fetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface OfficialIndex {
	/** The index's address (`OFFICIAL_INDEX_URL`, or `FAMOS_EXTENSION_INDEX_URL` in tests). */
	url: string;
	/** The keys its signature and its packages' must be by. */
	trustRoots: readonly TrustRoot[];
	fetch?: Fetch;
}

const ID = /^[a-z][a-z0-9]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const EntrySchema = z.object({
	id: z.string().max(64).regex(ID),
	version: z.string().max(32).regex(VERSION),
	sdk: z.string().max(32),
	url: z.string().max(500),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	size: z.number().int().positive().max(ARCHIVE_LIMITS.compressedBytes),
	labels: z.record(
		z.string().max(35),
		z.object({ name: z.string().max(200), description: z.string().max(2000) }),
	),
	reach: z
		.object({
			network: z.object({
				hosts: z.array(z.string().max(253)).max(50),
				userUrls: z.boolean(),
				local: z.boolean(),
			}),
			capabilities: z.number().int().min(0).max(1000),
			dependsOn: z.array(z.string().max(64)).max(50),
		})
		.optional(),
});

/** Fields this server does not know are left out, so a later index still reads here. */
const IndexSchema = z.object({
	format: z.literal(1),
	extensions: z.array(EntrySchema).max(5000),
});

const problem = (
	reason: 'unreachable' | 'missing' | 'unsigned' | 'invalid' | 'mismatch' | 'reach_changed',
	message: string,
) => new FamosError('bad_request', message, { reason });

/**
 * Reads an address with plain `fetch`, to a fixed host only: https, no redirect followed (a
 * redirect is refused), at most `maxBytes` (counted as it arrives, whatever the headers say) and
 * within `timeoutMs` for the whole answer.
 */
async function fetchCapped(
	fetchImpl: Fetch,
	url: URL,
	maxBytes: number,
	timeoutMs: number,
): Promise<Uint8Array> {
	if (url.protocol !== 'https:')
		throw problem('unreachable', `${url.href} is not an https address`);
	let res: Response;
	try {
		res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
	} catch {
		throw problem('unreachable', `${url.href} could not be reached`);
	}
	if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
		await res.body?.cancel();
		throw problem('unreachable', `${url.href} answered with a redirect, which is not followed`);
	}
	// The host answered but has no such file (not published yet, or taken down): that is not this
	// server's connection, so it is told apart from a host that could not be reached.
	if (res.status === 404 || res.status === 410) {
		await res.body?.cancel();
		throw problem('missing', `${url.href} answered ${res.status}`);
	}
	if (res.status !== 200) {
		await res.body?.cancel();
		throw problem('unreachable', `${url.href} answered ${res.status}`);
	}
	const tooLarge = () => problem('invalid', `${url.href} is larger than ${maxBytes} bytes`);
	if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
		await res.body?.cancel();
		throw tooLarge();
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		const reader = res.body?.getReader();
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw tooLarge();
			}
			chunks.push(value);
		}
	} catch (error) {
		if (isFamosError(error)) throw error;
		throw problem('unreachable', `${url.href} could not be read to its end`);
	}
	return Buffer.concat(chunks);
}

/** Checks `signature` (`{ keyId, sig }`) is a trusted key's over the exact `bytes`. */
function checkSignature(bytes: Uint8Array, signature: Uint8Array, roots: readonly TrustRoot[]) {
	let parsed: z.infer<typeof SignatureSchema>;
	try {
		parsed = SignatureSchema.parse(JSON.parse(Buffer.from(signature).toString('utf8')));
	} catch {
		throw problem('unsigned', 'The index signature is malformed');
	}
	const root = roots.find((r) => r.keyId === parsed.keyId);
	if (!root)
		throw problem(
			'unsigned',
			`The index is signed with a key this server does not trust (${parsed.keyId})`,
		);
	if (!verify(null, bytes, publicKeyOf(root), Buffer.from(parsed.sig, 'base64')))
		throw problem('unsigned', 'The index signature does not match it');
}

/**
 * Fetches the official index and its signature and checks it: signed by a trusted key over its
 * exact bytes, and an index this server reads. Each package's address is resolved against the
 * index and must be on the index's own host (https): one elsewhere is left out.
 */
export async function fetchIndex(official: OfficialIndex): Promise<IndexedPackage[]> {
	const fetchImpl = official.fetch ?? fetch;
	const url = new URL(official.url);
	const bytes = await fetchCapped(fetchImpl, url, INDEX_LIMITS.indexBytes, INDEX_LIMITS.indexMs);
	const signature = await fetchCapped(
		fetchImpl,
		new URL(`${url.href}.sig`),
		INDEX_LIMITS.signatureBytes,
		INDEX_LIMITS.indexMs,
	).catch((error: unknown) => {
		// The index is there and its signature is not: it is unsigned, not missing.
		if (isFamosError(error) && (error.details as { reason?: string })?.reason === 'missing')
			throw problem('unsigned', 'The index has no signature');
		throw error;
	});
	checkSignature(bytes, signature, official.trustRoots);
	let index: z.infer<typeof IndexSchema>;
	try {
		index = IndexSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
	} catch {
		throw problem('invalid', 'The index is not one this server reads');
	}
	return index.extensions.flatMap((entry) => {
		let at: URL;
		try {
			at = new URL(entry.url, url);
		} catch {
			return [];
		}
		if (at.protocol !== 'https:' || at.origin !== url.origin) return [];
		return [{ ...entry, url: at.href }];
	});
}

/** What a parsed manifest reaches, in the shape the index states it. */
export function reachOfParsed(manifest: ExtensionManifest): IndexReach {
	return {
		network: {
			hosts: [...(manifest.network?.hosts ?? [])].sort(),
			userUrls: manifest.network?.userUrls ?? false,
			local: manifest.network?.local ?? false,
		},
		capabilities: manifest.capabilities.length,
		dependsOn: [...manifest.dependsOn].sort(),
	};
}

/**
 * Refuses a package whose own manifest reaches more, or anything else, than the signed index
 * said before it was downloaded: the family decided on what the index stated.
 */
export function assertSameReach(entry: IndexedPackage, manifest: ExtensionManifest): void {
	if (!entry.reach) return;
	if (JSON.stringify(entry.reach) !== JSON.stringify(reachOfParsed(manifest)))
		throw problem(
			'reach_changed',
			`${entry.id} ${entry.version} reaches something other than the index says`,
		);
}

/**
 * Downloads a package the index lists and checks it is exactly the file the index describes
 * (its size and SHA-256). Its signature, files and manifest are checked after, when it is staged.
 */
export async function downloadPackage(
	entry: IndexedPackage,
	official: Pick<OfficialIndex, 'url' | 'fetch'>,
): Promise<Uint8Array> {
	const url = new URL(entry.url);
	// The address came from a signed index, which only names its own host; checked again here.
	if (url.origin !== new URL(official.url).origin)
		throw problem('unreachable', `${url.href} is not on the index's host`);
	const bytes = await fetchCapped(
		official.fetch ?? fetch,
		url,
		Math.min(entry.size, ARCHIVE_LIMITS.compressedBytes),
		INDEX_LIMITS.packageMs,
	).catch((error: unknown) => {
		// Larger than the index says: not the file it describes.
		if (isFamosError(error) && (error.details as { reason?: string })?.reason === 'invalid')
			throw problem('mismatch', `${url.href} is larger than the index says`);
		throw error;
	});
	if (bytes.byteLength !== entry.size)
		throw problem(
			'mismatch',
			`${url.href} has ${bytes.byteLength} bytes; the index says ${entry.size}`,
		);
	if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
		throw problem('mismatch', `${url.href} does not match the hash the index lists`);
	return bytes;
}
