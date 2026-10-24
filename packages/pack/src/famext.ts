import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign as signBytes,
} from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { compareVersions } from '@famos/sdk';
import * as tar from 'tar';
import { ARCHIVE_EXTENSION, keyIdOf, PACKAGE_FILE, SIGNATURE_FILE } from './format.ts';

export { ARCHIVE_EXTENSION, keyIdOf, SIGNATURE_FILE };

/** `famos-package.sig`: which key signed, and its ed25519 signature (base64). */
export interface PackageSignature {
	keyId: string;
	sig: string;
}

/** A new ed25519 key pair: the private key as PEM (PKCS #8), the public one as base64 SPKI DER. */
export function generateSigningKey(): { privateKey: string; publicKey: string; keyId: string } {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	return {
		privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
		publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
		keyId: keyIdOf(publicKey),
	};
}

/**
 * The signing key, as PEM, from a file or an environment variable (CI keeps it in a secret).
 * Never printed.
 */
export async function loadSigningKey(from: { file?: string; env?: string }): Promise<KeyObject> {
	const pem = from.file
		? await readFile(from.file, 'utf8')
		: from.env
			? process.env[from.env]
			: undefined;
	if (!pem) throw new Error('No signing key: give a key file or set the environment variable');
	const key = createPrivateKey(pem);
	if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be ed25519');
	return key;
}

/** Signs the exact bytes of a package's `famos-package.json`. */
export function sign(description: Uint8Array, privateKey: KeyObject | string): PackageSignature {
	const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
	return {
		keyId: keyIdOf(createPublicKey(key)),
		sig: signBytes(null, description, key).toString('base64'),
	};
}

/**
 * Packs a built package folder into a `.famext`: a gzip tar of `famos-package.json`, every file
 * it lists (and nothing else) and `famos-package.sig`. The files are checked against the hashes
 * first, so an archive never carries a package that was changed after it was built. Entries are
 * written in a fixed order with a fixed time, so packing twice gives the same bytes.
 */
export async function pack(
	dir: string,
	options: { privateKey: KeyObject | string; out: string },
): Promise<{ out: string; signature: PackageSignature }> {
	const bytes = await readFile(join(dir, PACKAGE_FILE));
	const description = JSON.parse(bytes.toString('utf8')) as { files?: Record<string, string> };
	const listed = Object.keys(description.files ?? {}).sort();
	for (const path of listed) {
		const hash = createHash('sha256')
			.update(await readFile(join(dir, path)))
			.digest('hex');
		if (hash !== description.files?.[path])
			throw new Error(`${path} in ${dir} changed after the package was built`);
	}
	const signature = sign(bytes, options.privateKey);
	const scratch = await mkdtemp(join(tmpdir(), 'famos-pack-'));
	try {
		const plain = join(scratch, 'package.tar');
		const common = { file: plain, portable: true, noDirRecurse: true, mtime: new Date(0) };
		await tar.c({ ...common, cwd: dir }, [PACKAGE_FILE, ...listed]);
		await writeFile(join(scratch, SIGNATURE_FILE), `${JSON.stringify(signature)}\n`);
		await tar.r({ ...common, cwd: scratch }, [SIGNATURE_FILE]);
		await writeFile(options.out, gzipSync(await readFile(plain)));
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
	return { out: options.out, signature };
}

/** The official index of published packages, and its signature beside it. */
export const INDEX_FILE = 'index.json';
export const INDEX_SIGNATURE_FILE = 'index.json.sig';

/** One published package in the index: what a server shows before it downloads, and checks after. */
export interface IndexEntry {
	id: string;
	version: string;
	/** The SDK range its manifest asks for (`^0.5.0`): a server skips what it cannot run. */
	sdk: string;
	/** Where the `.famext` is, relative to the index (`<id>/<id>-<version>.famext`). */
	url: string;
	/** Of the `.famext` file, hex. */
	sha256: string;
	size: number;
	labels: Record<string, { name: string; description: string }>;
	/**
	 * What the package reaches, from its manifest, so a family sees it before downloading. The
	 * server checks the downloaded manifest against it. Left out by an older index.
	 */
	reach?: IndexReach;
}

/** What a package reaches beyond its own data, as the index states it. */
export interface IndexReach {
	network: { hosts: string[]; userUrls: boolean; local: boolean };
	/** How many capabilities it adds. */
	capabilities: number;
	/** The extensions it needs. */
	dependsOn: string[];
}

/** The reach a manifest (as written in package.json, defaults not filled in) declares. */
export function reachOfManifest(manifest: Record<string, unknown>): IndexReach {
	const network = (manifest.network ?? {}) as {
		hosts?: unknown;
		userUrls?: unknown;
		local?: unknown;
	};
	const strings = (value: unknown) =>
		Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
	return {
		network: {
			hosts: strings(network.hosts).sort(),
			userUrls: network.userUrls === true,
			local: network.local === true,
		},
		capabilities: strings(manifest.capabilities).length,
		dependsOn: strings(manifest.dependsOn).sort(),
	};
}

/** `index.json`: every published package, by id, newest version first. */
export interface ExtensionIndex {
	format: 1;
	extensions: IndexEntry[];
}

/** What a packed package says it is, read from its `famos-package.json` without unpacking it. */
export async function readPackedDescription(file: string): Promise<{
	id: string;
	version: string;
	sdk: string;
	labels: IndexEntry['labels'];
	reach: IndexReach;
}> {
	const chunks: Buffer[] = [];
	await tar.t({
		file,
		filter: (path) => path === PACKAGE_FILE,
		onReadEntry: (entry) => {
			entry.on('data', (chunk: Buffer) => chunks.push(chunk));
		},
	});
	if (chunks.length === 0) throw new Error(`${file} holds no ${PACKAGE_FILE}`);
	const description = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
		manifest?: Record<string, unknown> & { id?: unknown; version?: unknown; sdk?: unknown };
		labels?: IndexEntry['labels'];
	};
	const { id, version, sdk } = description.manifest ?? {};
	if (typeof id !== 'string' || typeof version !== 'string' || typeof sdk !== 'string')
		throw new Error(`${file} has no manifest id, version and sdk`);
	return {
		id,
		version,
		sdk,
		labels: description.labels ?? {},
		reach: reachOfManifest(description.manifest ?? {}),
	};
}

/** Signs a file's exact bytes into `<file>.sig` (`{ keyId, sig }`): how the index is signed. */
export async function signFile(file: string, key: KeyObject): Promise<PackageSignature> {
	const signature = sign(await readFile(file), key);
	await writeFile(`${file}.sig`, `${JSON.stringify(signature)}\n`);
	return signature;
}

/**
 * Brings a published folder up to date: copies each new `.famext` to
 * `<dir>/<id>/<id>-<version>.famext`, keeps the newest `keep` versions of each extension (older
 * files are deleted; the GitHub releases still hold them), and writes `<dir>/index.json` listing
 * every file left. A version already published with other bytes is refused: a server that was
 * told one hash for a version must never be handed another. The index is written unsigned;
 * `signFile` signs it.
 */
export async function writeIndex(
	dir: string,
	options: { add?: readonly string[]; keep?: number } = {},
): Promise<{ index: ExtensionIndex; removed: string[] }> {
	const keep = options.keep ?? 5;
	if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a whole number above 0');
	for (const file of options.add ?? []) {
		const { id, version } = await readPackedDescription(file);
		const name = `${id}-${version}${ARCHIVE_EXTENSION}`;
		if (basename(file) !== name) throw new Error(`${file} holds ${id} ${version}: name it ${name}`);
		const target = join(dir, id, name);
		const existing = await readFile(target).catch(() => undefined);
		if (existing) {
			if (!existing.equals(await readFile(file)))
				throw new Error(`${id} ${version} is already published with other contents`);
			continue;
		}
		await mkdir(join(dir, id), { recursive: true });
		await copyFile(file, target);
	}
	const extensions: IndexEntry[] = [];
	const removed: string[] = [];
	const folders = (await readdir(dir, { withFileTypes: true }).catch(() => []))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	for (const folder of folders) {
		const found = [];
		for (const name of await readdir(join(dir, folder))) {
			if (!name.endsWith(ARCHIVE_EXTENSION)) continue;
			const path = join(dir, folder, name);
			const description = await readPackedDescription(path);
			if (description.id !== folder) throw new Error(`${path} holds ${description.id}`);
			found.push({ name, path, description });
		}
		found.sort((a, b) => compareVersions(b.description.version, a.description.version));
		for (const old of found.slice(keep)) {
			await rm(old.path);
			removed.push(`${folder}/${old.name}`);
		}
		for (const { name, path, description } of found.slice(0, keep)) {
			const bytes = await readFile(path);
			extensions.push({
				id: description.id,
				version: description.version,
				sdk: description.sdk,
				url: `${folder}/${name}`,
				sha256: createHash('sha256').update(bytes).digest('hex'),
				size: bytes.byteLength,
				labels: description.labels,
				reach: description.reach,
			});
		}
	}
	const index: ExtensionIndex = { format: 1, extensions };
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, INDEX_FILE), `${JSON.stringify(index, null, '\t')}\n`);
	return { index, removed };
}
