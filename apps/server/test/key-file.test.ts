import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import type { CoreTables } from '@famos/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const BASE = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';
const PATH = '/api/v1/backups/key-file';
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;
let dataDir: string;
let ip = 0;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'famos-keyfile-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
		extensions,
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
		keyFile: runtime.config.secret,
		identity: runtime.identity,
		knownDevices: runtime.knownDevices,
		logger: silentLogger,
		trustedOrigins: [BASE],
		appVersion: APP_VERSION,
		secureCookies: false,
		trustedProxies: ['127.0.0.1'],
	});
});
afterEach(() => runtime.close());

async function call(
	method: string,
	path: string,
	body?: unknown,
	cookie?: string,
	extra: { headers?: Record<string, string>; address?: string } = {},
) {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			'x-forwarded-for': extra.address ?? `10.7.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`,
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(cookie && { cookie }),
			...extra.headers,
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return {
		status: res.status,
		headers: res.headers,
		text,
		body: text.startsWith('{') ? JSON.parse(text) : null,
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

async function signIn(email: string, password: string) {
	const res = await call('POST', '/api/auth/sign-in/email', { email, password });
	expect(res.status).toBe(200);
	return res.cookie;
}

async function admin() {
	const setup = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: PASSWORD,
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	expect(setup.status).toBe(201);
	return signIn('parent@example.com', PASSWORD);
}

const auditRows = () =>
	runtime.kernel.ctx.db
		.withTables<CoreTables>()
		.selectFrom('core_audit_log')
		.select(['action_id', 'actor', 'target'])
		.where('action_id', '=', 'core.downloadKeyFile')
		.execute();

describe('Saving the server key file', () => {
	it('answers an admin with the file exactly as the data folder holds it, and audits it', async () => {
		const cookie = await admin();
		const res = await call('POST', PATH, { password: PASSWORD }, cookie);
		expect(res.status).toBe(200);
		expect(res.text).toBe(await readFile(join(dataDir, 'secret'), 'utf8'));
		expect(res.text).toBe(`${runtime.config.secret}\n`);
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[^"]+"$/);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('content-type')).toMatch(/^text\/plain/);

		const rows = await auditRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.target).toBeNull();
		expect(JSON.stringify(rows)).not.toContain(runtime.config.secret);
	});

	it('refuses a wrong password, counts it, and then locks the guesser out', async () => {
		const cookie = await admin();
		const address = '10.9.9.9';
		for (let i = 0; i < 5; i++) {
			const res = await call('POST', PATH, { password: 'not the password!' }, cookie, { address });
			expect(res.status).toBe(403);
			expect(res.body.error.details.reason).toBe('wrong_password');
			expect(res.text).not.toContain(runtime.config.secret);
		}
		// Even the right password waits once the lock is on.
		const locked = await call('POST', PATH, { password: PASSWORD }, cookie, { address });
		expect(locked.status).toBe(429);
		expect(locked.body.error.details.retryAfter).toBeGreaterThan(0);
		expect(locked.text).not.toContain(runtime.config.secret);
		expect(await auditRows()).toHaveLength(0);
		// The lock is the sign-in's: the same account from the same address cannot sign in either.
		const signInRes = await call(
			'POST',
			'/api/auth/sign-in/email',
			{ email: 'parent@example.com', password: PASSWORD },
			undefined,
			{ address },
		);
		expect(signInRes.status).toBe(429);
	});

	it('is refused without a session, without the capability, and for a child on a PIN', async () => {
		const cookie = await admin();
		expect((await call('POST', PATH, { password: PASSWORD })).status).toBe(401);

		const aunt = (
			await call(
				'POST',
				'/api/v1/actions/core.createMember',
				{ displayName: 'Aunt', roleId: 'member' },
				cookie,
			)
		).body.output;
		expect(
			(
				await call(
					'PUT',
					`/api/v1/core/members/${aunt.id}/password`,
					{ password: 'another horse battery', email: 'aunt@example.com' },
					cookie,
				)
			).status,
		).toBe(200);
		const auntCookie = await signIn('aunt@example.com', 'another horse battery');
		const refused = await call('POST', PATH, { password: 'another horse battery' }, auntCookie);
		expect(refused.status).toBe(403);
		expect(refused.text).not.toContain(runtime.config.secret);

		const kid = (
			await call(
				'POST',
				'/api/v1/actions/core.createMember',
				{ displayName: 'Kid', roleId: 'supervised' },
				cookie,
			)
		).body.output;
		await call('PUT', `/api/v1/core/members/${kid.id}/pin`, { pin: '2468' }, cookie);
		const device = await call('POST', '/api/v1/core/devices/trust', { name: 'Tablet' }, cookie);
		const pin = await call(
			'POST',
			'/api/auth/sign-in/pin',
			{ memberId: kid.id, pin: '2468' },
			device.cookie,
		);
		expect(pin.status).toBe(200);
		const kidTry = await call('POST', PATH, { password: PASSWORD }, pin.cookie);
		expect(kidTry.status).toBe(403);
		expect(kidTry.text).not.toContain(runtime.config.secret);
		expect(await auditRows()).toHaveLength(0);
	});

	it('is refused for a family display and for a bearer key', async () => {
		const cookie = await admin();
		const start = await call('POST', '/api/v1/core/displays/pair');
		await call(
			'POST',
			'/api/v1/actions/core.confirmDisplayPairing',
			{
				userCode: start.body.userCode,
				name: 'Hallway',
				capabilities: ['calendar.view'],
				showNames: false,
			},
			cookie,
		);
		const poll = await call('POST', '/api/v1/core/displays/pair/poll', {
			deviceCode: start.body.deviceCode,
		});
		const display = await call('POST', PATH, { password: PASSWORD }, poll.cookie);
		expect([401, 403]).toContain(display.status);
		expect(display.text).not.toContain(runtime.config.secret);

		for (const door of ['/mcp', '/api/public/v1/backups/key-file']) {
			const bearer = await call('POST', door, { password: PASSWORD }, undefined, {
				headers: { authorization: 'Bearer famos_nonsense' },
			});
			expect(bearer.text).not.toContain(runtime.config.secret);
		}
		// A bearer sent to the session door is refused even beside a good session cookie.
		const mixed = await call('POST', PATH, { password: PASSWORD }, cookie, {
			headers: { authorization: 'Bearer famos_nonsense' },
		});
		expect(mixed.status).toBeGreaterThanOrEqual(400);
		expect(mixed.text).not.toContain(runtime.config.secret);
		expect(await auditRows()).toHaveLength(0);
	});

	it('serves FAMOS_SECRET when the installer set one', async () => {
		const set = 's'.repeat(40);
		const config = await loadConfig({
			FAMOS_DATA_DIR: await mkdtemp(join(tmpdir(), 'famos-keyfile-env-')),
			FAMOS_BASE_URL: BASE,
			FAMOS_SECRET: set,
		});
		expect(config.secret).toBe(set);
	});
});
