import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { generateSigningKey, pack, sign } from '@famos/pack/famext';
import { parseManifest, SDK_VERSION } from '@famos/sdk';
import type { TrustRoot } from '../../src/packages/trust.ts';

/** A key the tests trust, generated once per run, and one they do not. */
export const TEST_KEY = generateSigningKey();
export const OTHER_KEY = generateSigningKey();
export const TEST_ROOTS: readonly TrustRoot[] = [
	{ keyId: TEST_KEY.keyId, kind: 'official', publicKey: TEST_KEY.publicKey },
];

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Writes a built package as `@famos/pack` lays one out. Its server module is a plain definition
 * object (no imports), so it loads in any process.
 */
export function writePackage(
	root: string,
	id: string,
	version: string,
	options: {
		manifest?: Record<string, unknown>;
		built?: string;
		extra?: Record<string, string>;
	} = {},
): string {
	const dir = mkdtempSync(join(root, `${id}-${version}-`));
	const manifest = options.manifest ?? { id, version, sdk: `^${SDK_VERSION}` };
	const parsed = (() => {
		try {
			return parseManifest(manifest);
		} catch {
			return manifest;
		}
	})();
	const files: Record<string, string> = {
		'server/index.mjs': `export default ${JSON.stringify({
			migrations: {},
			actions: [],
			routes: [],
			jobs: [],
			events: [],
			capabilities: [],
			notifications: [],
			sensitive: false,
			manifest: parsed,
			id,
		})};\n`,
		'messages/en.json': `${JSON.stringify({ feature_name: id, feature_description: `The ${id}` })}\n`,
		...options.extra,
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	const description = {
		format: 1,
		manifest,
		name: `@test/${id}`,
		license: 'AGPL-3.0-or-later',
		built: { sdk: options.built ?? SDK_VERSION, svelte: '5.57.1' },
		entries: { server: 'server/index.mjs' },
		labels: { en: { name: id, description: `The ${id}` } },
		files: Object.fromEntries(
			Object.entries(files)
				.map(([path, text]) => [path, sha256(text)] as const)
				.sort(([a], [b]) => a.localeCompare(b)),
		),
	};
	writeFileSync(join(dir, 'famos-package.json'), `${JSON.stringify(description, null, '\t')}\n`);
	return dir;
}

/** Packs and signs a package folder (with the trusted key unless told otherwise). */
export async function famext(dir: string, privateKey = TEST_KEY.privateKey): Promise<Buffer> {
	const out = join(mkdtempSync(join(tmpdir(), 'famos-famext-')), 'package.famext');
	await pack(dir, { privateKey, out });
	return readFileSync(out);
}

export interface TarEntry {
	path: string;
	/** `0` file (default), `1` hard link, `2` symbolic link, `5` folder, `3` character device. */
	type?: '0' | '1' | '2' | '3' | '5';
	body?: string | Buffer;
	linkpath?: string;
}

/**
 * A ustar archive written by hand, so a test can make entries no packer would: links, devices,
 * paths that climb out.
 */
export function ustar(entries: readonly TarEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const body = Buffer.from(entry.body ?? '');
		const header = Buffer.alloc(512);
		header.write(entry.path, 0, 100, 'utf8');
		header.write('0000644\0', 100, 'ascii');
		header.write('0000000\0', 108, 'ascii');
		header.write('0000000\0', 116, 'ascii');
		header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
		header.write('00000000000\0', 136, 'ascii');
		header.write('        ', 148, 'ascii');
		header.write(entry.type ?? '0', 156, 'ascii');
		if (entry.linkpath) header.write(entry.linkpath, 157, 100, 'utf8');
		header.write('ustar\u000000', 257, 'ascii');
		let sum = 0;
		for (const byte of header) sum += byte;
		header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
		blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

/** The entries of a signed package folder, ready to be changed and archived again with `ustar`. */
export function entriesOf(dir: string, files: readonly string[]): TarEntry[] {
	return files.map((path) => ({ path, body: readFileSync(join(dir, path)) }));
}

/** A `.famext` made by hand: the package's files and its signature, plus whatever a test adds. */
export function handMade(
	dir: string,
	options: { add?: TarEntry[]; change?: Record<string, string>; privateKey?: string } = {},
): Buffer {
	const description = readFileSync(join(dir, 'famos-package.json'));
	const listed = Object.keys(
		(JSON.parse(description.toString('utf8')) as { files: Record<string, string> }).files,
	);
	const signature = sign(description, options.privateKey ?? TEST_KEY.privateKey);
	const entries: TarEntry[] = [
		{ path: 'famos-package.json', body: description },
		...entriesOf(dir, listed).map((e) =>
			options.change?.[e.path] !== undefined ? { ...e, body: options.change[e.path] } : e,
		),
		{ path: 'famos-package.sig', body: JSON.stringify(signature) },
		...(options.add ?? []),
	];
	return gzipSync(ustar(entries));
}
