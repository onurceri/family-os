import { createHash, verify } from 'node:crypto';
import {
	type ExtensionManifest,
	parseManifest,
	reservedClash,
	SDK_VERSION,
	satisfiesCaret,
	tablePrefixOf,
} from '@famos/sdk';
import { z } from 'zod';
import { builtForThisHost } from '../extensions/load.ts';
import { digestOf, PACKAGE_FILE } from '../extensions/web.ts';
import { isSafePath, type PackageFiles, refusePackage } from './archive.ts';
import { publicKeyOf, type TrustRoot } from './trust.ts';

/** The file of an archive that signs `famos-package.json` (written by `@famos/pack`). */
export const SIGNATURE_FILE = 'famos-package.sig';

const SignatureSchema = z.object({ keyId: z.string().max(64), sig: z.base64().max(200) });

const DescriptionSchema = z.object({
	format: z.literal(1),
	manifest: z.unknown(),
	name: z.string().max(214),
	license: z.string().max(200),
	built: z.object({ sdk: z.string(), svelte: z.string() }),
	entries: z.object({
		server: z.string(),
		web: z.string().optional(),
		css: z.string().optional(),
	}),
	labels: z.record(
		z.string().max(35),
		z.object({ name: z.string().max(200), description: z.string().max(2000) }),
	),
	files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});

/** A package whose signature, files and manifest were all checked. */
export interface VerifiedPackage {
	id: string;
	version: string;
	manifest: ExtensionManifest;
	labels: Record<string, { name: string; description: string }>;
	/** The key that signed it. */
	signer: { keyId: string; kind: TrustRoot['kind'] };
	/** Of `famos-package.json`: the name of its folder in the store. */
	digest: string;
	files: PackageFiles;
}

const refuse = refusePackage;

/**
 * Checks a package before any of its code is used:
 * - `famos-package.sig` is a signature of the exact bytes of `famos-package.json` by a key in
 *   `trustRoots` (the description lists every file's hash, so the signature covers them all);
 * - every file it lists is there with that hash, and it holds no file it does not list;
 * - its manifest reads, is not named like the host and asks for this SDK;
 * - it was built for this platform, and its entries are files it lists.
 */
export function verifyPackage(
	files: PackageFiles,
	trustRoots: readonly TrustRoot[],
): VerifiedPackage {
	const descriptionBytes = files.get(PACKAGE_FILE);
	if (!descriptionBytes) throw refuse(`The package has no ${PACKAGE_FILE}`, 'no_description');
	const signatureBytes = files.get(SIGNATURE_FILE);
	if (!signatureBytes) throw refuse('The package is not signed', 'not_signed');
	const signature = SignatureSchema.safeParse(parseJson(signatureBytes));
	if (!signature.success) throw refuse(`${SIGNATURE_FILE} is malformed`, 'bad_signature_file');
	const keyId = signature.data.keyId;
	const root = trustRoots.find((r) => r.keyId === keyId);
	if (!root)
		throw refuse(
			`The package is signed with a key this server does not trust (${keyId})`,
			'untrusted_key',
			{ keyId: keyId.slice(0, 64) },
		);
	const signed = verify(
		null,
		descriptionBytes,
		publicKeyOf(root),
		Buffer.from(signature.data.sig, 'base64'),
	);
	if (!signed)
		throw refuse('The package signature does not match its contents', 'signature_mismatch');

	const parsed = DescriptionSchema.safeParse(parseJson(descriptionBytes));
	if (!parsed.success)
		throw refuse(`${PACKAGE_FILE} is not a package description this host reads`, 'bad_description');
	const description = parsed.data;
	for (const [path, hash] of Object.entries(description.files)) {
		const named = { path: path.slice(0, 120) };
		if (!isSafePath(path) || path === PACKAGE_FILE || path === SIGNATURE_FILE)
			throw refuse(`The package lists an unsafe path: ${path}`, 'unsafe_path', named);
		const bytes = files.get(path);
		if (!bytes)
			throw refuse(`The package lists ${path}, which it does not hold`, 'file_missing', named);
		if (createHash('sha256').update(bytes).digest('hex') !== hash)
			throw refuse(`${path} does not match the hash the package lists`, 'file_mismatch', named);
	}
	for (const path of files.keys()) {
		if (path === PACKAGE_FILE || path === SIGNATURE_FILE) continue;
		if (!(path in description.files))
			throw refuse(`The package holds ${path}, which it does not list`, 'unlisted_file', {
				path: path.slice(0, 120),
			});
	}

	let manifest: ExtensionManifest;
	try {
		manifest = parseManifest(description.manifest);
	} catch (error) {
		throw refuse(error instanceof Error ? error.message : String(error), 'bad_manifest');
	}
	const clash = reservedClash(manifest.id, tablePrefixOf(manifest));
	if (clash)
		throw refuse(`The extension ${manifest.id} cannot be installed: ${clash}`, 'reserved_name', {
			id: manifest.id,
		});
	if (!satisfiesCaret(SDK_VERSION, manifest.sdk))
		throw refuse(
			`The extension ${manifest.id} needs SDK ${manifest.sdk}; this server has ${SDK_VERSION}`,
			'sdk',
			{ needs: manifest.sdk, has: SDK_VERSION },
		);
	if (!builtForThisHost(description.built.sdk))
		throw refuse(
			`The extension ${manifest.id} was built for platform ${description.built.sdk}; this server is ${SDK_VERSION}`,
			'platform',
			{ built: description.built.sdk.slice(0, 32), has: SDK_VERSION },
		);
	const { server, web, css } = description.entries;
	for (const entry of [server, web, css]) {
		if (entry !== undefined && !(entry in description.files))
			throw refuse(`The package has an entry it does not list: ${entry}`, 'bad_entry');
	}
	if (web !== undefined && !web.startsWith('web/'))
		throw refuse(`The package has its web entry outside web/: ${web}`, 'bad_entry');

	return {
		id: manifest.id,
		version: manifest.version,
		manifest,
		labels: description.labels,
		signer: { keyId: root.keyId, kind: root.kind },
		digest: digestOf(descriptionBytes),
		files,
	};
}

function parseJson(bytes: Buffer): unknown {
	try {
		return JSON.parse(bytes.toString('utf8'));
	} catch {
		return undefined;
	}
}
