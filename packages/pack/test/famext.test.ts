import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { afterAll, describe, expect, it } from 'vitest';
import {
	generateSigningKey,
	INDEX_FILE,
	INDEX_SIGNATURE_FILE,
	keyIdOf,
	loadSigningKey,
	pack,
	readPackedDescription,
	SIGNATURE_FILE,
	signFile,
	writeIndex,
} from '../src/famext.ts';
import { hashFiles, PACKAGE_FILE } from '../src/index.ts';

const scratch = mkdtempSync(join(tmpdir(), 'famos-famext-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A package folder with its description, and a stray file the description does not list. */
async function packageDir(): Promise<string> {
	const dir = mkdtempSync(join(scratch, 'pkg-'));
	mkdirSync(join(dir, 'server'));
	writeFileSync(join(dir, 'server/index.mjs'), 'export default {};\n');
	writeFileSync(join(dir, 'LICENSE'), 'license\n');
	const files = await hashFiles(dir);
	writeFileSync(join(dir, PACKAGE_FILE), `${JSON.stringify({ format: 1, files })}\n`);
	writeFileSync(join(dir, 'stray.txt'), 'not listed\n');
	return dir;
}

async function entries(file: string): Promise<Map<string, Buffer>> {
	const found = new Map<string, Buffer>();
	await tar.t({
		file,
		onReadEntry: (entry) => {
			const chunks: Buffer[] = [];
			entry.on('data', (c: Buffer) => chunks.push(c));
			entry.on('end', () => found.set(entry.path, Buffer.concat(chunks)));
		},
	});
	return found;
}

describe('a packed package', () => {
	it('holds the description, the files it lists and a signature of the description', async () => {
		const key = generateSigningKey();
		const dir = await packageDir();
		const out = join(scratch, 'one.famext');
		const { signature } = await pack(dir, { privateKey: key.privateKey, out });
		const files = await entries(out);
		expect([...files.keys()]).toEqual([
			PACKAGE_FILE,
			'LICENSE',
			'server/index.mjs',
			SIGNATURE_FILE,
		]);
		expect(JSON.parse(files.get(SIGNATURE_FILE)?.toString() ?? '')).toEqual(signature);
		expect(signature.keyId).toBe(key.keyId);
		const publicKey = createPublicKey({
			key: Buffer.from(key.publicKey, 'base64'),
			format: 'der',
			type: 'spki',
		});
		expect(keyIdOf(publicKey)).toBe(key.keyId);
		const description = readFileSync(join(dir, PACKAGE_FILE));
		expect(verify(null, description, publicKey, Buffer.from(signature.sig, 'base64'))).toBe(true);
	});

	it('is refused when a file changed after the package was built', async () => {
		const dir = await packageDir();
		writeFileSync(join(dir, 'LICENSE'), 'changed\n');
		await expect(
			pack(dir, { privateKey: generateSigningKey().privateKey, out: join(scratch, 'x.famext') }),
		).rejects.toThrow(/LICENSE .* changed after the package was built/);
	});

	it('reads the signing key from a file or the environment, ed25519 only', async () => {
		const key = generateSigningKey();
		const file = join(scratch, 'key.pem');
		writeFileSync(file, key.privateKey);
		expect((await loadSigningKey({ file })).asymmetricKeyType).toBe('ed25519');
		process.env.FAMOS_TEST_SIGNING_KEY = key.privateKey;
		try {
			expect((await loadSigningKey({ env: 'FAMOS_TEST_SIGNING_KEY' })).asymmetricKeyType).toBe(
				'ed25519',
			);
		} finally {
			delete process.env.FAMOS_TEST_SIGNING_KEY;
		}
		await expect(loadSigningKey({ env: 'FAMOS_TEST_NO_SUCH_KEY' })).rejects.toThrow(
			/No signing key/,
		);
	});
});

describe('the published index', () => {
	const key = generateSigningKey();

	/** A packed package of `id` at `version`, named as a release names it. */
	async function packed(
		id: string,
		version: string,
		license = 'license\n',
		extra: Record<string, unknown> = {},
	): Promise<string> {
		const dir = mkdtempSync(join(scratch, `${id}-`));
		mkdirSync(join(dir, 'server'));
		writeFileSync(join(dir, 'server/index.mjs'), 'export default {};\n');
		writeFileSync(join(dir, 'LICENSE'), license);
		const files = await hashFiles(dir);
		const description = {
			format: 1,
			manifest: { id, version, sdk: '^0.5.0', ...extra },
			labels: { en: { name: id, description: `The ${id}` } },
			files,
		};
		writeFileSync(join(dir, PACKAGE_FILE), `${JSON.stringify(description)}\n`);
		const out = join(mkdtempSync(join(scratch, 'out-')), `${id}-${version}.famext`);
		await pack(dir, { privateKey: key.privateKey, out });
		return out;
	}

	it('lists every published file, newest version first, and keeps the newest few', async () => {
		const site = mkdtempSync(join(scratch, 'site-'));
		const first = await packed('garden', '1.0.0');
		await writeIndex(site, { add: [first, await packed('pond', '0.1.0')] });
		const { index, removed } = await writeIndex(site, {
			add: [await packed('garden', '1.10.0'), await packed('garden', '1.2.0')],
			keep: 2,
		});
		expect(removed).toEqual(['garden/garden-1.0.0.famext']);
		expect(index.extensions.map((e) => `${e.id}@${e.version}`)).toEqual([
			'garden@1.10.0',
			'garden@1.2.0',
			'pond@0.1.0',
		]);
		const [newest] = index.extensions;
		const bytes = readFileSync(join(site, 'garden/garden-1.10.0.famext'));
		expect(newest).toEqual({
			id: 'garden',
			version: '1.10.0',
			sdk: '^0.5.0',
			url: 'garden/garden-1.10.0.famext',
			sha256: createHash('sha256').update(bytes).digest('hex'),
			size: bytes.byteLength,
			labels: { en: { name: 'garden', description: 'The garden' } },
			reach: {
				network: { hosts: [], userUrls: false, local: false },
				capabilities: 0,
				dependsOn: [],
			},
		});
		expect(JSON.parse(readFileSync(join(site, INDEX_FILE), 'utf8'))).toEqual(index);
		expect(await readPackedDescription(first)).toMatchObject({ id: 'garden', version: '1.0.0' });
	});

	it('states what a package reaches, from its manifest', async () => {
		const site = mkdtempSync(join(scratch, 'site-'));
		const file = await packed('weather', '1.0.0', 'license\n', {
			network: { hosts: ['b.example.org', 'a.example.org'], userUrls: true },
			capabilities: ['weather.view', 'weather.manage'],
			dependsOn: ['ambient', 'calendar'],
			optional: ['lists'],
		});
		const { index } = await writeIndex(site, { add: [file] });
		expect(index.extensions[0]?.reach).toEqual({
			network: { hosts: ['a.example.org', 'b.example.org'], userUrls: true, local: false },
			capabilities: 2,
			dependsOn: ['ambient', 'calendar'],
		});
		// Signed with the rest of the index: the file holds it.
		expect(JSON.parse(readFileSync(join(site, INDEX_FILE), 'utf8')).extensions[0].reach).toEqual(
			index.extensions[0]?.reach,
		);
	});

	it('never publishes one version with other bytes, or under another name', async () => {
		const site = mkdtempSync(join(scratch, 'site-'));
		await writeIndex(site, { add: [await packed('garden', '1.0.0')] });
		// The same bytes again (a workflow run twice) are fine.
		await writeIndex(site, { add: [await packed('garden', '1.0.0')] });
		await expect(
			writeIndex(site, { add: [await packed('garden', '1.0.0', 'other\n')] }),
		).rejects.toThrow(/already published with other contents/);
		const misnamed = join(scratch, 'garden.famext');
		writeFileSync(misnamed, readFileSync(await packed('garden', '2.0.0')));
		await expect(writeIndex(site, { add: [misnamed] })).rejects.toThrow(/name it garden-2.0.0/);
	});

	it('signs the index file into index.json.sig', async () => {
		const site = mkdtempSync(join(scratch, 'site-'));
		await writeIndex(site, {});
		const file = join(site, INDEX_FILE);
		const signature = await signFile(file, await loadSigningKey({ file: keyFile(key) }));
		expect(JSON.parse(readFileSync(join(site, INDEX_SIGNATURE_FILE), 'utf8'))).toEqual(signature);
		const publicKey = createPublicKey({
			key: Buffer.from(key.publicKey, 'base64'),
			format: 'der',
			type: 'spki',
		});
		expect(verify(null, readFileSync(file), publicKey, Buffer.from(signature.sig, 'base64'))).toBe(
			true,
		);
	});
});

function keyFile(key: { privateKey: string }): string {
	const file = join(mkdtempSync(join(scratch, 'key-')), 'key.pem');
	writeFileSync(file, key.privateKey);
	return file;
}
