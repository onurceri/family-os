import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain script without types
import { runtimeLock } from './runtime-lock.mjs';

const lockText = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const server = JSON.parse(
	readFileSync(new URL('../apps/server/package.json', import.meta.url), 'utf8'),
);
const version = server.dependencies['better-sqlite3'];

describe('the runtime image lockfile', () => {
	it('holds the locked native module and what it needs, with integrity hashes', () => {
		const lock = runtimeLock(lockText, { 'better-sqlite3': version });
		expect(lock.packages['node_modules/better-sqlite3'].version).toBe(version);
		expect(lock.packages['node_modules/better-sqlite3'].integrity).toMatch(/^sha512-/);
		const addon = lock.packages['node_modules/node-addon-api'];
		expect(addon.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(addon.integrity).toMatch(/^sha512-/);
		expect(lock.packages['node_modules/better-sqlite3'].dependencies['node-addon-api']).toBe(
			addon.version,
		);
	});

	it('refuses a package the lockfile does not hold', () => {
		expect(() => runtimeLock(lockText, { 'better-sqlite3': '0.0.1' })).toThrow(/not in pnpm-lock/);
	});
});
