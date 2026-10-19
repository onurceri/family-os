import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { defineRoute, type Logger } from '@famos/sdk';
import { defineTestExtension } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';

const BASE = 'http://localhost:3000';

const feed = defineRoute({
	method: 'get',
	path: '/feed/{secret}/calendar.ics',
	operationId: 'probe.feed',
	summary: 'A feed that fails',
	requires: 'public',
	params: z.object({ secret: z.string() }),
	response: z.object({ ok: z.boolean() }),
	async handle() {
		throw new Error('boom');
	},
});

let runtime: Runtime;
const lines: object[] = [];
const logger: Logger = {
	debug: (obj) => void lines.push(obj),
	info: (obj) => void lines.push(obj),
	warn: (obj) => void lines.push(obj),
	error: (obj) => void lines.push(obj),
	child: () => silentLogger,
};

beforeEach(async () => {
	lines.length = 0;
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-errlog-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
		extensions: [defineTestExtension({ id: 'probe', routes: [feed] })],
	});
	await migrate(runtime);
	await runtime.kernel.start();
});
afterEach(() => runtime.close());

describe('the unhandled-error log', () => {
	it('names the route pattern and never the secret address', async () => {
		const app = createHttpApp({
			kernel: runtime.kernel,
			ai: runtime.ai,
			webPush: runtime.webPush,
			telegram: runtime.telegram,
			email: runtime.email,
			backups: runtime.backups,
			backupsDir: runtime.config.backupsDir,
			backupSchedule: runtime.config.backup,
			identity: runtime.identity,
			logger,
			trustedOrigins: [BASE],
			appVersion: APP_VERSION,
			secureCookies: false,
			trustedProxies: ['127.0.0.1'],
		});
		const res = await app.request(`${BASE}/api/v1/probe/feed/s3cr3t-token-value/calendar.ics`);
		expect(res.status).toBe(500);
		const logged = JSON.stringify(lines, (_k, v) => (v instanceof Error ? v.message : v));
		expect(logged).toContain('/api/v1/probe/feed/:secret/calendar.ics');
		expect(logged).not.toContain('s3cr3t-token-value');
	});
});
