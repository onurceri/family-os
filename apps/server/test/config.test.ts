import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

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
