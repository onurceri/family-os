import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, parseEnvironment } from '../src/config.ts';

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'famos-config-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('public address', () => {
	it('is unset when only the local default applies', async () => {
		const config = await loadConfig({ FAMOS_DATA_DIR: dir, PORT: '3111' });
		expect(config.baseURL).toBe('http://localhost:3111');
		expect(config.publicURL).toBeUndefined();
	});

	it('is the configured base URL without a trailing slash', async () => {
		const config = await loadConfig({
			FAMOS_DATA_DIR: dir,
			FAMOS_BASE_URL: 'http://192.168.1.20:3000/',
		});
		expect(config.publicURL).toBe('http://192.168.1.20:3000');
	});
});

describe('the persisted secret', () => {
	it('is created once, then reused', async () => {
		const first = await loadConfig({ FAMOS_DATA_DIR: dir });
		expect(first.secret.length).toBeGreaterThanOrEqual(32);
		const second = await loadConfig({ FAMOS_DATA_DIR: dir });
		expect(second.secret).toBe(first.secret);
		expect((await readFile(join(dir, 'secret'), 'utf8')).trim()).toBe(first.secret);
	});

	it('is created by only one of two starts at once', async () => {
		const [a, b] = await Promise.all([
			loadConfig({ FAMOS_DATA_DIR: dir }),
			loadConfig({ FAMOS_DATA_DIR: dir }),
		]);
		expect(a.secret).toBe(b.secret);
		expect((await readFile(join(dir, 'secret'), 'utf8')).trim()).toBe(a.secret);
	});

	it('keeps a hand-placed secret of the length FAMOS_SECRET accepts', async () => {
		const own = 's'.repeat(32);
		await writeFile(join(dir, 'secret'), own);
		expect((await loadConfig({ FAMOS_DATA_DIR: dir })).secret).toBe(own);
	});

	it('stops the start on a file that is too short and leaves it untouched', async () => {
		await writeFile(join(dir, 'secret'), 'too-short\n');
		await expect(loadConfig({ FAMOS_DATA_DIR: dir })).rejects.toThrow(
			/fewer than 32 characters.*will not replace/s,
		);
		expect(await readFile(join(dir, 'secret'), 'utf8')).toBe('too-short\n');
	});

	it('stops the start on an empty file', async () => {
		await writeFile(join(dir, 'secret'), '');
		await expect(loadConfig({ FAMOS_DATA_DIR: dir })).rejects.toThrow(/fewer than 32/);
		expect(await readFile(join(dir, 'secret'), 'utf8')).toBe('');
	});
});

describe('FAMOS_ROLES', () => {
	it('runs both parts when not set', async () => {
		const config = await loadConfig({ FAMOS_DATA_DIR: dir });
		expect(config.roles).toEqual({ api: true, worker: true });
	});

	it('accepts one role or both, with spaces', async () => {
		expect((await loadConfig({ FAMOS_DATA_DIR: dir, FAMOS_ROLES: 'worker' })).roles).toEqual({
			api: false,
			worker: true,
		});
		expect(
			(await loadConfig({ FAMOS_DATA_DIR: dir, FAMOS_ROLES: ' api , worker ' })).roles,
		).toEqual({
			api: true,
			worker: true,
		});
	});

	it.each(['apis', 'API', '', ',', 'api,wroker'])('refuses %j before starting', async (value) => {
		await expect(loadConfig({ FAMOS_DATA_DIR: dir, FAMOS_ROLES: value })).rejects.toThrow(
			/Invalid configuration: FAMOS_ROLES/,
		);
	});
});

describe('settings for development and tests', () => {
	it.each([
		['FAMOS_DEV_EXTENSIONS', '../../extensions'],
		['FAMOS_EMAIL_FAKE_DIR', '/tmp/mail'],
		['FAMOS_NOTIFY_DELAY_MS', '500'],
	])('%s is refused in production', async (name, value) => {
		await expect(
			loadConfig({ FAMOS_DATA_DIR: dir, NODE_ENV: 'production', [name]: value }),
		).rejects.toThrow(new RegExp(`${name}.*refused when NODE_ENV=production`));
		expect(await loadConfig({ FAMOS_DATA_DIR: dir, [name]: value })).toBeDefined();
	});

	it('leaves the Telegram server address and index mirror to the operator', async () => {
		const config = await loadConfig({
			FAMOS_DATA_DIR: dir,
			NODE_ENV: 'production',
			FAMOS_TELEGRAM_API_ROOT: 'http://telegram.lan:8081',
			FAMOS_EXTENSION_INDEX_URL: 'https://mirror.example/index.json',
		});
		expect(config.telegramApiRoot).toBe('http://telegram.lan:8081');
		expect(config.extensionIndexUrl).toBe('https://mirror.example/index.json');
	});

	it('reads the backup passphrase and dev extensions into the config', async () => {
		const config = await loadConfig({
			FAMOS_DATA_DIR: dir,
			FAMOS_BACKUP_PASSPHRASE: 'open sesame',
			FAMOS_DEV_EXTENSIONS: '../../extensions',
		});
		expect(config.backupPassphrase).toBe('open sesame');
		expect(config.devExtensionsDir).toBe('../../extensions');
		// Empty is kept: restore then refuses an encrypted backup instead of asking on a terminal.
		expect(
			(await loadConfig({ FAMOS_DATA_DIR: dir, FAMOS_BACKUP_PASSPHRASE: '' })).backupPassphrase,
		).toBe('');
		expect((await loadConfig({ FAMOS_DATA_DIR: dir })).backupPassphrase).toBeUndefined();
		expect(parseEnvironment({}).NODE_ENV).toBeUndefined();
	});
});
