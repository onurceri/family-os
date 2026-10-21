import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { sourceExtensions } from './support/extensions.ts';

const [calendar] = await sourceExtensions('calendar');

const BASE = 'http://localhost:3000';
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;
let cookie: string;
let ip = 0;

const post = (path: string, body: unknown, withCookie = true) =>
	app.request(`${BASE}${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: BASE,
			'x-forwarded-for': `10.3.0.${++ip}`,
			...(withCookie && { cookie }),
		},
		body: JSON.stringify(body),
	});

beforeEach(async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-feeds-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
		extensions: [calendar],
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
		knownDevices: runtime.knownDevices,
		logger: silentLogger,
		trustedOrigins: [BASE],
		appVersion: APP_VERSION,
		secureCookies: false,
		trustedProxies: ['127.0.0.1'],
	});
	await post(
		'/api/v1/core/setup',
		{
			displayName: 'P',
			email: 'p@example.com',
			password: 'correct horse battery',
			locale: 'en',
			setupCode: runtime.config.setupCode,
		},
		false,
	);
	const res = await post(
		'/api/auth/sign-in/email',
		{ email: 'p@example.com', password: 'correct horse battery' },
		false,
	);
	cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.join('; ');
});
afterEach(() => runtime.close());

it('serves a feed as text/calendar to anyone with the address, and 404 otherwise', async () => {
	const me = await (await app.request(`${BASE}/api/v1/core/me`, { headers: { cookie } })).json();
	const memberId =
		(me as { member?: { id: string }; id?: string }).member?.id ?? (me as { id: string }).id;
	await post('/api/v1/actions/calendar.createEvent', {
		title: 'Zoo, trip',
		date: '2026-10-10',
		startTime: '10:00',
	});
	const created = await post('/api/v1/actions/calendar.createFeed', {
		scope: memberId,
		label: 'Phone',
	});
	expect(created.status).toBeLessThan(300);
	const { output } = (await created.json()) as { output: { token: string; path: string } };

	// No cookie: the address is the credential.
	const res = await app.request(`${BASE}${output.path}`);
	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
	expect(res.headers.get('cache-control')).toBe('private, max-age=300');
	expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	const text = await res.text();
	expect(text).toContain('BEGIN:VCALENDAR');
	expect(text).toContain('SUMMARY:Zoo\\, trip');

	const missing = await app.request(`${BASE}/api/v1/calendar/feed/${'a'.repeat(43)}.ics`);
	expect(missing.status).toBe(404);
	// Listing needs a session, and never shows the address.
	expect((await app.request(`${BASE}/api/v1/calendar/feeds`)).status).toBe(401);
	const list = await app.request(`${BASE}/api/v1/calendar/feeds`, { headers: { cookie } });
	expect(await list.text()).not.toContain(output.token);
});

it('refuses a subscription to a private address with the real guard', async () => {
	const added = await post('/api/v1/actions/calendar.addSubscription', {
		name: 'Inside',
		url: 'https://127.0.0.1/private.ics?key=SECRET',
	});
	expect(added.status).toBeLessThan(300);
	await runtime.kernel.worker.drain();
	const list = await app.request(`${BASE}/api/v1/calendar/subscriptions`, { headers: { cookie } });
	const text = await list.text();
	expect(JSON.parse(text)).toMatchObject([{ host: '127.0.0.1', lastError: 'blocked_address' }]);
	expect(text).not.toContain('SECRET');
});
