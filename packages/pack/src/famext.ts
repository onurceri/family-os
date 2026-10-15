import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign as signBytes,
} from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import { PACKAGE_FILE } from './package.ts';

/** The file in a `.famext` archive that holds the signature of `famos-package.json`. */
export const SIGNATURE_FILE = 'famos-package.sig';

/** The extension of a packed, signed extension package. */
export const ARCHIVE_EXTENSION = '.famext';

/** `famos-package.sig`: which key signed, and its ed25519 signature (base64). */
export interface PackageSignature {
	keyId: string;
	sig: string;
}

/**
 * A key's id: the first 16 hex digits of the SHA-256 of its public key (SPKI, DER). It is
 * derived, so a signature can never name a key it was not made with; the host computes it the
 * same way for its trust roots.
 */
export function keyIdOf(publicKey: KeyObject): string {
	const der = publicKey.export({ format: 'der', type: 'spki' });
	return createHash('sha256').update(der).digest('hex').slice(0, 16);
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
