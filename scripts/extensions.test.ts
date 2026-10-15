import { execFileSync, spawnSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

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
