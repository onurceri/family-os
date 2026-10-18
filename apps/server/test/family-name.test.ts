import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();
const BASE = 'http://localhost:3000';

let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;

beforeEach(async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-name-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		extensions,
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
	});
	await migrate(runtime);
	await runtime.kernel.start();
	app = createHttpApp({
		kernel: runtime.kernel,
		ai: runtime.ai,
		webPush: runtime.webPush,
		telegram: runtime.telegram,
		email: runtime.email,
		backups: runtime.backups,
		backupsDir: runtime.config.backupsDir,
		backupSchedule: runtime.config.backup,
		identity: runtime.identity,
		logger: silentLogger,
		trustedOrigins: [BASE],
		appVersion: APP_VERSION,
		secureCookies: false,
		trustedProxies: ['127.0.0.1'],
	});
});
afterEach(() => runtime.close());

let ip = 0;
async function call(method: string, path: string, body?: unknown, cookie?: string) {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			'x-forwarded-for': `10.3.0.${++ip}`,
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(cookie && { cookie }),
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return {
		status: res.status,
		body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

async function setup(extra: Record<string, unknown> = {}) {
	const created = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: 'correct horse battery',
		locale: 'en',
		setupCode: runtime.config.setupCode,
		...extra,
	});
	expect(created.status).toBe(201);
	const signIn = await call('POST', '/api/auth/sign-in/email', {
		email: 'parent@example.com',
		password: 'correct horse battery',
	});
	return signIn.cookie;
}

describe('the family name', () => {
	it('is none before the family chose one, and public once it did', async () => {
		expect((await call('GET', '/api/v1/core/setup')).body.familyName).toBeNull();
		await setup({ familyName: ' The Novaks ' });
		// The sign-in page reads it before anyone is signed in.
		expect((await call('GET', '/api/v1/core/setup')).body.familyName).toBe('The Novaks');
	});

	it('stays empty when setup leaves it out, and can be set and cleared later', async () => {
		const cookie = await setup();
		expect((await call('GET', '/api/v1/core/setup')).body.familyName).toBeNull();
		const set = await call('POST', '/api/v1/actions/core.setFamilyName', { name: 'Ours' }, cookie);
		expect(set.body).toMatchObject({ status: 'applied', output: { name: 'Ours' } });
		expect((await call('GET', '/api/v1/core/setup')).body.familyName).toBe('Ours');
		await call('POST', '/api/v1/actions/core.setFamilyName', { name: '' }, cookie);
		expect((await call('GET', '/api/v1/core/setup')).body.familyName).toBeNull();
	});
});
