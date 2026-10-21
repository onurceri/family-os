import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { createKnownDevices, KNOWN_DEVICE_COOKIE } from '../src/http/known-devices.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const BASE = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';
const WRONG = 'wrong password!!';
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;

beforeEach(async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-lockout-'));
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
		identity: runtime.identity,
		knownDevices: runtime.knownDevices,
		logger: silentLogger,
		trustedOrigins: [BASE],
		appVersion: APP_VERSION,
		secureCookies: false,
		// The test client stands behind a proxy, so each call can name its own address.
		trustedProxies: ['127.0.0.1'],
	});
});
afterEach(() => runtime.close());

async function call(
	path: string,
	body: unknown,
	options: { ip?: string; cookie?: string; headers?: Record<string, string>; method?: string } = {},
) {
	const res = await app.request(`${BASE}${path}`, {
		method: options.method ?? 'POST',
		headers: {
			origin: BASE,
			'content-type': 'application/json',
			'x-forwarded-for': options.ip ?? '192.0.2.1',
			...(options.cookie && { cookie: options.cookie }),
			...options.headers,
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	return {
		status: res.status,
		body: text.startsWith('{') ? JSON.parse(text) : text,
		setCookies: res.headers.getSetCookie(),
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

const signIn = (email: string, password: string, ip: string, cookie?: string) =>
	call('/api/auth/sign-in/email', { email, password }, { ip, ...(cookie && { cookie }) });

/** The sign-in cookie alone, as a browser would send it back to the sign-in endpoint. */
const knownCookieOf = (res: { setCookies: string[] }) =>
	res.setCookies.find((c) => c.startsWith(`${KNOWN_DEVICE_COOKIE}=`))?.split(';')[0] ?? '';

/** A family with two adults; the admin's own laptop signed in once from home. */
async function household() {
	const setup = await call('/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: PASSWORD,
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	expect(setup.status).toBe(201);
	const laptop = await signIn('parent@example.com', PASSWORD, '192.0.2.10');
	expect(laptop.status).toBe(200);
	const created = await call(
		'/api/v1/actions/core.createMember',
		{ displayName: 'Partner', roleId: 'member' },
		{ cookie: laptop.cookie },
	);
	const partnerId = created.body.output.id as string;
	expect(
		(
			await call(
				`/api/v1/core/members/${partnerId}/password`,
				{ email: 'partner@example.com', password: PASSWORD },
				{ cookie: laptop.cookie, method: 'PUT' },
			)
		).status,
	).toBe(200);
	return { session: laptop.cookie, known: knownCookieOf(laptop) };
}

/** Twenty wrong passwords for the admin from as many addresses: a distributed guess. */
async function strangersGuess() {
	for (let i = 0; i < 20; i++)
		expect((await signIn('parent@example.com', WRONG, `198.51.100.${i + 1}`)).status).toBe(401);
}

describe('a stranger cannot lock a family member out of password sign-in', () => {
	it('locks one address for the account after five wrong passwords; another still signs in', async () => {
		await household();
		for (let i = 0; i < 5; i++)
			expect((await signIn('parent@example.com', WRONG, '203.0.113.7')).status).toBe(401);
		const locked = await signIn('parent@example.com', PASSWORD, '203.0.113.7');
		expect(locked.status).toBe(429);
		expect(locked.body).toMatchObject({ code: 'LOCKED' });
		expect((await signIn('parent@example.com', PASSWORD, '203.0.113.8')).status).toBe(200);
	});

	it('lets a browser that signed in before through the account backstop; an unknown one waits', async () => {
		const { known } = await household();
		expect(known).toMatch(new RegExp(`^${KNOWN_DEVICE_COOKIE}=.+`));
		await strangersGuess();
		const unknown = await signIn('parent@example.com', PASSWORD, '192.0.2.20');
		expect(unknown.status).toBe(429);
		expect(unknown.body).toMatchObject({ code: 'LOCKED' });
		expect((await signIn('parent@example.com', PASSWORD, '192.0.2.20', known)).status).toBe(200);
	});

	it('sets the sign-in cookie for scripts never to read, on the sign-in endpoints only', async () => {
		await household();
		const again = await signIn('parent@example.com', PASSWORD, '192.0.2.10');
		const header = again.setCookies.find((c) => c.startsWith(`${KNOWN_DEVICE_COOKIE}=`)) ?? '';
		expect(header).toMatch(/HttpOnly/);
		expect(header).toMatch(/SameSite=Strict/);
		expect(header).toMatch(/Path=\/api\/auth/);
		// A wrong password sets nothing.
		expect(knownCookieOf(await signIn('parent@example.com', WRONG, '192.0.2.11'))).toBe('');
	});

	it('does not let another account’s cookie, a forged or a tampered one through', async () => {
		await household();
		const partner = await signIn('partner@example.com', PASSWORD, '192.0.2.30');
		const partnerCookie = knownCookieOf(partner);
		expect(partnerCookie).not.toBe('');
		const known = knownCookieOf(await signIn('parent@example.com', PASSWORD, '192.0.2.31'));
		await strangersGuess();

		const refused = async (cookie: string) =>
			expect((await signIn('parent@example.com', PASSWORD, '192.0.2.32', cookie)).status).toBe(429);
		await refused(partnerCookie);
		const value = known.slice(KNOWN_DEVICE_COOKIE.length + 1);
		const [tag, issued, signature] = value.split('.');
		const flipped = `${signature?.slice(0, -1)}${signature?.endsWith('A') ? 'B' : 'A'}`;
		await refused(`${KNOWN_DEVICE_COOKIE}=${tag}.${issued}.${flipped}`);
		await refused(
			`${KNOWN_DEVICE_COOKIE}=${tag}.${(Number.parseInt(issued ?? '0', 36) + 1).toString(36)}.${signature}`,
		);
		// The same entry signed with another server's secret.
		const elsewhere = createKnownDevices('another family server secret, 32+ chars');
		await refused(elsewhere.remember(null, 'parent@example.com', false).split(';')[0] as string);
		// The browser that holds both entries is let through for each.
		const both = await signIn('partner@example.com', PASSWORD, '192.0.2.33', known);
		const shared = knownCookieOf(both);
		expect((await signIn('parent@example.com', PASSWORD, '192.0.2.34', shared)).status).toBe(200);
	});

	it('lets a family device through the account backstop', async () => {
		const { session } = await household();
		const device = await call(
			'/api/v1/core/devices/trust',
			{ name: 'Kitchen' },
			{ cookie: session },
		);
		expect(device.status).toBe(201);
		const deviceCookie = device.setCookies
			.find((c) => c.startsWith('famos_device='))
			?.split(';')[0];
		await strangersGuess();
		expect((await signIn('parent@example.com', PASSWORD, '192.0.2.40', deviceCookie)).status).toBe(
			200,
		);
	});

	it('ignores a client that claims to be a known device', async () => {
		await household();
		await strangersGuess();
		const res = await call(
			'/api/auth/sign-in/email',
			{ email: 'parent@example.com', password: PASSWORD },
			{ ip: '192.0.2.50', headers: { 'x-famos-known-device': '1' } },
		);
		expect(res.status).toBe(429);
	});

	it('counts IPv6 addresses of one /64 as one guesser', async () => {
		await household();
		for (let i = 0; i < 5; i++)
			expect(
				(await signIn('parent@example.com', WRONG, `2001:db8:5:6::${(i + 1).toString(16)}`)).status,
			).toBe(401);
		expect((await signIn('parent@example.com', PASSWORD, '2001:db8:5:6:a:b:c:d')).status).toBe(429);
		expect((await signIn('parent@example.com', PASSWORD, '2001:db8:5:7::1')).status).toBe(200);
	});
});
