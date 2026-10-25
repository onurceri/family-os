import { spawn } from 'node:child_process';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beat, HEARTBEAT_FILE } from '../src/heartbeat.ts';

const script = new URL('../../../docker/healthcheck.mjs', import.meta.url).pathname;

let dir: string;
let server: Server | undefined;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'famos-health-'));
});
afterEach(async () => {
	server?.close();
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

/** Runs the image's health check; resolves to its exit code. */
async function check(env: Record<string, string>): Promise<number | null> {
	const { PATH } = process.env;
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [script], {
			env: { PATH, FAMOS_DATA_DIR: dir, ...env },
		});
		child.on('close', resolve);
	});
}

async function listen(ok: boolean): Promise<string> {
	const local = createServer((_req, res) => res.writeHead(ok ? 200 : 503).end());
	server = local;
	await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
	return String((local.address() as AddressInfo).port);
}

describe('the image health check', () => {
	it('asks /health when the container serves the API', async () => {
		expect(await check({ PORT: await listen(true) })).toBe(0);
		server?.close();
		expect(await check({ PORT: await listen(false), FAMOS_ROLES: 'api,worker' })).toBe(1);
		server?.close();
		// Nothing listens at all.
		expect(await check({ PORT: '1', FAMOS_ROLES: 'api' })).toBe(1);
	});

	it('reads a fresh heartbeat when the container runs only the worker', async () => {
		expect(await check({ FAMOS_ROLES: 'worker' })).toBe(1);
		beat(dir);
		expect(await check({ FAMOS_ROLES: 'worker', PORT: '1' })).toBe(0);
		beat(dir);
		expect(await check({ FAMOS_ROLES: ' worker ' })).toBe(0);
	});

	it('fails a worker-only container whose heartbeat went stale', async () => {
		beat(dir);
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(join(dir, HEARTBEAT_FILE), old, old);
		expect(await check({ FAMOS_ROLES: 'worker' })).toBe(1);
		beat(dir);
		expect(await check({ FAMOS_ROLES: 'worker' })).toBe(0);
	});
});
