import { execFileSync, spawnSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generateSigningKey, pack } from '../packages/pack/src/famext.ts';
import { hashFiles, PACKAGE_FILE } from '../packages/pack/src/index.ts';

const scratch = mkdtempSync(join(tmpdir(), 'famos-ext-scripts-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const script = (name: string) => join(import.meta.dirname, name);
const run = (name: string, ...args: string[]) =>
	spawnSync('node', [script(name), ...args], { encoding: 'utf8' });

describe('the release key script', () => {
	it('writes a new private key only to its file, mode 600, and prints the trust root', () => {
		const file = join(scratch, 'key.pem');
		const out = run('extension-key.mjs', 'generate', '--out', file);
		expect(out.status).toBe(0);
		expect(out.stderr).toBe('');
		const pem = readFileSync(file, 'utf8');
		expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		// The private key never reaches the output.
		const body = pem.split('\n')[1] ?? '';
		expect(out.stdout).not.toContain(body);
		expect(out.stdout).not.toContain('PRIVATE KEY-----');
		const keyId = out.stdout.match(/keyId: '([0-9a-f]{16})'/)?.[1];
		expect(keyId).toBeDefined();
		// Never overwritten.
		expect(run('extension-key.mjs', 'generate', '--out', file).status).toBe(1);
		expect(readFileSync(file, 'utf8')).toBe(pem);
		// Not a key the server trusts.
		const check = run('extension-key.mjs', 'check', '--key-file', file);
		expect(check.status).toBe(1);
		expect(check.stderr).toContain(`The key ${keyId} is not among the server's trust roots`);
	});
});

describe('the extensions script', () => {
	/** A signed package of `id` at 0.1.0, named as a release names it. */
	async function packed(id: string, privateKey: string): Promise<string> {
		const dir = mkdtempSync(join(scratch, `${id}-`));
		mkdirSync(join(dir, 'server'));
		writeFileSync(join(dir, 'server/index.mjs'), 'export default {};\n');
		const description = {
			format: 1,
			manifest: { id, version: '0.1.0', sdk: '^0.8.0' },
			labels: { en: { name: id, description: `The ${id}` } },
			files: await hashFiles(dir),
		};
		writeFileSync(join(dir, PACKAGE_FILE), `${JSON.stringify(description)}\n`);
		const out = join(mkdtempSync(join(scratch, 'out-')), `${id}-0.1.0.famext`);
		await pack(dir, { privateKey, out });
		return out;
	}

	it('adds every package a release gives after --add, not only the first', async () => {
		const { privateKey } = generateSigningKey();
		const files = [await packed('pond', privateKey), await packed('garden', privateKey)];
		const site = join(scratch, 'release-site');
		const out = run('extensions.mjs', 'index', site, '--add', ...files);
		expect(out.status).toBe(0);
		const index = JSON.parse(readFileSync(join(site, 'index.json'), 'utf8'));
		expect(index.extensions.map((e: { id: string }) => e.id).sort()).toEqual(['garden', 'pond']);
	});

	it('writes an empty index and signs it with a key from the environment', () => {
		const file = join(scratch, 'sign-key.pem');
		execFileSync('node', [script('extension-key.mjs'), 'generate', '--out', file]);
		const site = join(scratch, 'site');
		const index = run('extensions.mjs', 'index', site);
		expect(index.status).toBe(0);
		expect(JSON.parse(readFileSync(join(site, 'index.json'), 'utf8'))).toEqual({
			format: 1,
			extensions: [],
		});
		const signed = spawnSync(
			'node',
			[script('extensions.mjs'), 'sign', join(site, 'index.json'), '--key-env', 'TEST_KEY'],
			{ encoding: 'utf8', env: { ...process.env, TEST_KEY: readFileSync(file, 'utf8') } },
		);
		expect(signed.status).toBe(0);
		const sig = JSON.parse(readFileSync(join(site, 'index.json.sig'), 'utf8'));
		const publicKey = createPublicKey(readFileSync(file, 'utf8'));
		expect(
			verify(
				null,
				readFileSync(join(site, 'index.json')),
				publicKey,
				Buffer.from(sig.sig, 'base64'),
			),
		).toBe(true);
	});

	it('needs a key to pack or sign', () => {
		const out = run('extensions.mjs', 'pack', '--out', join(scratch, 'packed'));
		expect(out.status).toBe(2);
		expect(out.stderr).toContain('--key-env or --key-file');
	});
});
