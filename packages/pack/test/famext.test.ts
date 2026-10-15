import { createPublicKey, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { afterAll, describe, expect, it } from 'vitest';
import {
	generateSigningKey,
	keyIdOf,
	loadSigningKey,
	pack,
	SIGNATURE_FILE,
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
