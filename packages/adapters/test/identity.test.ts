import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, runMigrations } from '@famos/db';
import { getMigrations } from 'better-auth/db/migration';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	authOptions,
	createIdentity,
	type Identity,
	identityMigrations,
} from '../src/identity-betterauth/index.ts';

const BASE = 'http://localhost:3000';
/**
 * A salted SHA-256 stands in for better-auth's scrypt, which takes long enough under CPU load
 * to exceed the test timeout. The password flow around it is unchanged.
 */
const digest = (salt: string, password: string) =>
	createHash('sha256').update(`${salt}:${password}`).digest('hex');
const passwordHasher = {
	hash: async (password: string) => {
		const salt = randomBytes(8).toString('hex');
		return `${salt}:${digest(salt, password)}`;
	},
	verify: async ({ hash, password }: { hash: string; password: string }) => {
		const [salt = '', expected] = hash.split(':');
		return digest(salt, password) === expected;
	},
};
let identity: Identity;
let db: ReturnType<typeof openDatabase>['db'];
/** Members whose role no longer signs in with a PIN. */
const noPin = new Set<string>();
/** The clock the sign-in locks read. */
let clock = 0;

beforeEach(async () => {
	clock = Date.now();
	({ db } = openDatabase({ path: ':memory:' }));
	await runMigrations(db, [{ scope: 'identity', migrations: identityMigrations }]);
	// Requests with the header `x-test-device: <id>` count as coming from a family device.
	identity = createIdentity({
		db,
		secret: 's'.repeat(32),
		baseURL: BASE,
		secureCookies: false,
		trustedDevice: async (headers) => headers.get('x-test-device'),
		mayUsePin: async (memberId) => !noPin.has(memberId),
		passwordHasher,
		now: () => clock,
	});
});

const post = (path: string, body: unknown, ip = '10.0.0.1', trusted = true, known = false) =>
	identity.handler(
		new Request(`${BASE}/api/auth${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: BASE,
				'x-famos-client-ip': ip,
				...(trusted && { 'x-test-device': 'device_1' }),
				...(known && { 'x-famos-known-device': '1' }),
			},
			body: JSON.stringify(body),
		}),
	);

const cookieOf = (res: Response) =>
	res.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.join('; ');

describe('identity-betterauth', () => {
	it('signs in with the default password hashing', { timeout: 120_000 }, async () => {
		// scrypt is memory- and CPU-bound by design, so how long it takes depends on the machine.
		const real = createIdentity({
			db,
			secret: 's'.repeat(32),
			baseURL: BASE,
			secureCookies: false,
			trustedDevice: async () => null,
			mayUsePin: async () => true,
		});
		await real.admin.setPasswordLogin({
			memberId: 'member_real',
			email: 'real@example.com',
			password: 'correct horse battery',
			displayName: 'R',
		});
		const res = await real.handler(
			new Request(`${BASE}/api/auth/sign-in/email`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: BASE },
				body: JSON.stringify({ email: 'real@example.com', password: 'correct horse battery' }),
			}),
		);
		expect(res.status).toBe(200);
	});

	it('committed migrations match what better-auth expects', async () => {
		const plan = await getMigrations(
			authOptions({
				db,
				secret: 's'.repeat(32),
				baseURL: BASE,
				trustedDevice: async () => 'device_1',
				mayUsePin: async () => true,
			}),
		);
		expect(plan.toBeCreated).toEqual([]);
		expect(plan.toBeAdded).toEqual([]);
	});

	it('signs in with email + password and resolves the member', async () => {
		await identity.admin.setPasswordLogin({
			memberId: 'member_a',
			email: 'Parent@Example.com',
			password: 'correct horse battery',
			displayName: 'P',
		});
		const bad = await post('/sign-in/email', {
			email: 'parent@example.com',
			password: 'wrong password!!',
		});
		expect(bad.status).toBe(401);
		const res = await post('/sign-in/email', {
			email: 'parent@example.com',
			password: 'correct horse battery',
		});
		expect(res.status).toBe(200);
		const who = await identity.resolveMember(new Headers({ cookie: cookieOf(res) }));
		expect(who?.memberId).toBe('member_a');
	});

	it('does not allow public sign-up', async () => {
		const res = await post('/sign-up/email', {
			email: 'x@example.com',
			password: 'correct horse battery',
			name: 'X',
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	it('never limits password sign-ins that succeed, however many come from one address', async () => {
		await identity.admin.setPasswordLogin({
			memberId: 'member_a',
			email: 'a@example.com',
			password: 'correct horse battery',
			displayName: 'A',
		});
		for (let i = 0; i < 8; i++) {
			const res = await post(
				'/sign-in/email',
				{ email: 'a@example.com', password: 'correct horse battery' },
				'10.0.0.20',
			);
			expect(res.status).toBe(200);
		}
	});

	it('limits wrong passwords from one address across accounts', async () => {
		for (let i = 0; i < 10; i++) {
			const res = await post(
				'/sign-in/email',
				{ email: `nobody${i}@example.com`, password: 'wrong password!!' },
				'10.0.0.21',
			);
			expect(res.status).toBe(401);
		}
		const limited = await post(
			'/sign-in/email',
			{ email: 'nobody0@example.com', password: 'wrong password!!' },
			'10.0.0.21',
		);
		expect(limited.status).toBe(429);
		expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
	});

	it('signs in with a PIN', async () => {
		await identity.admin.setPin({ memberId: 'member_kid', pin: '1234', displayName: 'Kid' });
		expect(
			(await post('/sign-in/pin', { memberId: 'member_kid', pin: '9999' }, '10.0.0.2')).status,
		).toBe(401);
		const ok = await post('/sign-in/pin', { memberId: 'member_kid', pin: '1234' }, '10.0.0.2');
		expect(ok.status).toBe(200);
		expect((await identity.resolveMember(new Headers({ cookie: cookieOf(ok) })))?.memberId).toBe(
			'member_kid',
		);
	});

	it('never limits PIN sign-ins that succeed, however many come from one tablet', async () => {
		await identity.admin.setPin({ memberId: 'member_a', pin: '1234', displayName: 'A' });
		await identity.admin.setPin({ memberId: 'member_b', pin: '5678', displayName: 'B' });
		for (let i = 0; i < 12; i++) {
			const [memberId, pin] = i % 2 ? ['member_a', '1234'] : ['member_b', '5678'];
			expect((await post('/sign-in/pin', { memberId, pin }, '10.0.0.3')).status).toBe(200);
		}
	});

	it('limits wrong PINs from one address across accounts, with its own code', async () => {
		for (let i = 0; i < 10; i++) {
			await identity.admin.setPin({ memberId: `member_${i}`, pin: '1234', displayName: `M${i}` });
			const res = await post('/sign-in/pin', { memberId: `member_${i}`, pin: '0000' }, '10.0.0.6');
			expect(res.status).toBe(401);
		}
		// Even the right PIN waits: the address has used up its tries, not the account.
		const limited = await post('/sign-in/pin', { memberId: 'member_0', pin: '1234' }, '10.0.0.6');
		expect(limited.status).toBe(429);
		expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(
			(await post('/sign-in/pin', { memberId: 'member_0', pin: '1234' }, '10.0.0.8')).status,
		).toBe(200);
	});

	it('does not count refusals from untrusted devices toward the lockout', async () => {
		await identity.admin.setPin({ memberId: 'member_kid', pin: '1234', displayName: 'Kid' });
		for (let i = 0; i < 8; i++) {
			const res = await post(
				'/sign-in/pin',
				{ memberId: 'member_kid', pin: '0000' },
				'10.0.0.10',
				false,
			);
			expect(res.status).toBe(403);
		}
		expect(
			(await post('/sign-in/pin', { memberId: 'member_kid', pin: '1234' }, '10.0.0.10')).status,
		).toBe(200);
	});

	it('refuses a correct PIN once the role no longer signs in with a PIN', async () => {
		await identity.admin.setPin({ memberId: 'member_kid', pin: '1234', displayName: 'Kid' });
		noPin.add('member_kid');
		try {
			expect(
				(await post('/sign-in/pin', { memberId: 'member_kid', pin: '1234' }, '10.0.0.7')).status,
			).toBe(401);
		} finally {
			noPin.delete('member_kid');
		}
	});

	it('refuses PIN sign-in from devices that are not trusted, even with the right PIN', async () => {
		await identity.admin.setPin({ memberId: 'member_kid', pin: '1234', displayName: 'Kid' });
		const res = await post(
			'/sign-in/pin',
			{ memberId: 'member_kid', pin: '1234' },
			'10.0.0.9',
			false,
		);
		expect(res.status).toBe(403);
	});

	it('gives one person a PIN and a password, both working, and tells which they have', async () => {
		expect(await identity.admin.signInMethods()).toEqual(new Map());
		await identity.admin.setPin({ memberId: 'member_teen', pin: '1234', displayName: 'Teen' });
		await identity.admin.setPasswordLogin({
			memberId: 'member_teen',
			email: 'teen@example.com',
			password: 'correct horse battery',
			displayName: 'Teen',
		});
		await identity.admin.setPasswordLogin({
			memberId: 'member_a',
			email: 'parent@example.com',
			password: 'correct horse battery',
			displayName: 'P',
		});
		expect(await identity.admin.signInMethods()).toEqual(
			new Map([
				['member_teen', { password: true, pin: true }],
				['member_a', { password: true, pin: false }],
			]),
		);
		const byPin = await post('/sign-in/pin', { memberId: 'member_teen', pin: '1234' }, '10.0.0.5');
		expect(byPin.status).toBe(200);
		const byPassword = await post('/sign-in/email', {
			email: 'teen@example.com',
			password: 'correct horse battery',
		});
		expect(byPassword.status).toBe(200);
		const who = await identity.resolveMember(new Headers({ cookie: cookieOf(byPassword) }));
		expect(who).toMatchObject({ memberId: 'member_teen', deviceId: null });
	});

	it('changing a PIN invalidates the old one; revokeAll ends sessions', async () => {
		await identity.admin.setPin({ memberId: 'member_kid', pin: '1234', displayName: 'Kid' });
		const session = await post('/sign-in/pin', { memberId: 'member_kid', pin: '1234' }, '10.0.0.4');
		await identity.admin.setPin({ memberId: 'member_kid', pin: '5678', displayName: 'Kid' });
		expect(
			(await post('/sign-in/pin', { memberId: 'member_kid', pin: '1234' }, '10.0.0.4')).status,
		).toBe(401);
		expect(
			(await post('/sign-in/pin', { memberId: 'member_kid', pin: '5678' }, '10.0.0.4')).status,
		).toBe(200);

		await identity.admin.revokeAll('member_kid');
		expect(await identity.resolveMember(new Headers({ cookie: cookieOf(session) }))).toBeNull();
	});

	it('ends sessions per member and per device', async () => {
		await identity.admin.setPin({ memberId: 'member_kid', pin: '1234', displayName: 'Kid' });
		const pin = await post('/sign-in/pin', { memberId: 'member_kid', pin: '1234' }, '10.0.0.5');
		const cookie = new Headers({ cookie: cookieOf(pin) });
		expect(await identity.resolveMember(cookie)).not.toBeNull();
		await identity.admin.endDeviceSessions('device_other');
		expect(await identity.resolveMember(cookie)).not.toBeNull();
		await identity.admin.endDeviceSessions('device_1');
		expect(await identity.resolveMember(cookie)).toBeNull();

		const again = await post('/sign-in/pin', { memberId: 'member_kid', pin: '1234' }, '10.0.0.5');
		await identity.admin.endSessions('member_kid');
		expect(await identity.resolveMember(new Headers({ cookie: cookieOf(again) }))).toBeNull();
		// The PIN itself still works.
		expect(
			(await post('/sign-in/pin', { memberId: 'member_kid', pin: '1234' }, '10.0.0.5')).status,
		).toBe(200);
	});

	it('locks an account after five failures, from any address', async () => {
		await identity.admin.setPin({ memberId: 'member_kid', pin: '1234', displayName: 'Kid' });
		for (let i = 0; i < 5; i++) {
			const res = await post(
				'/sign-in/pin',
				{ memberId: 'member_kid', pin: '0000' },
				`10.9.0.${i}`,
			);
			expect(res.status).toBe(401);
		}
		const locked = await post('/sign-in/pin', { memberId: 'member_kid', pin: '1234' }, '10.9.1.1');
		expect(locked.status).toBe(429);
		expect(await locked.json()).toMatchObject({ code: 'LOCKED', retryAfter: 900 });
		expect(locked.headers.get('retry-after')).toBe('900');
		// Other accounts are unaffected.
		await identity.admin.setPin({ memberId: 'member_b', pin: '1234', displayName: 'B' });
		expect(
			(await post('/sign-in/pin', { memberId: 'member_b', pin: '1234' }, '10.9.1.2')).status,
		).toBe(200);
	});

	it('rejects an email already used by another member', async () => {
		await identity.admin.setPasswordLogin({
			memberId: 'member_a',
			email: 'a@example.com',
			password: 'correct horse battery',
			displayName: 'A',
		});
		await expect(
			identity.admin.setPasswordLogin({
				memberId: 'member_b',
				email: 'a@example.com',
				password: 'correct horse battery',
				displayName: 'B',
			}),
		).rejects.toMatchObject({ code: 'conflict' });
	});

	describe('wrong passwords lock the guesser, not the person', () => {
		const RIGHT = 'correct horse battery';
		const WRONG = 'wrong password!!';
		const signIn = (password: string, ip: string, known = false) =>
			post('/sign-in/email', { email: 'parent@example.com', password }, ip, false, known);
		beforeEach(() =>
			identity.admin.setPasswordLogin({
				memberId: 'member_a',
				email: 'parent@example.com',
				password: RIGHT,
				displayName: 'P',
			}),
		);

		it('locks one address for the account after five wrong passwords; another still signs in', async () => {
			for (let i = 0; i < 5; i++) expect((await signIn(WRONG, '203.0.113.7')).status).toBe(401);
			const locked = await signIn(RIGHT, '203.0.113.7');
			expect(locked.status).toBe(429);
			expect(await locked.json()).toMatchObject({ code: 'LOCKED', retryAfter: 900 });
			expect((await signIn(RIGHT, '198.51.100.4')).status).toBe(200);
			// The lock runs out after 15 minutes.
			clock += 15 * 60_000;
			expect((await signIn(RIGHT, '203.0.113.7')).status).toBe(200);
		});

		it('locks unknown devices out after twenty wrong passwords from many addresses, never a known one', async () => {
			for (let i = 0; i < 20; i++)
				expect((await signIn(WRONG, `203.0.113.${i + 1}`)).status).toBe(401);
			const unknown = await signIn(RIGHT, '198.51.100.4');
			expect(unknown.status).toBe(429);
			expect(await unknown.json()).toMatchObject({ code: 'LOCKED', retryAfter: 3600 });
			expect((await signIn(RIGHT, '198.51.100.5', true)).status).toBe(200);
			// A right password does not lift the backstop for strangers.
			expect((await signIn(RIGHT, '198.51.100.6')).status).toBe(429);
			clock += 60 * 60_000;
			expect((await signIn(RIGHT, '198.51.100.6')).status).toBe(200);
		});

		it('still locks a known device after its own five wrong passwords', async () => {
			for (let i = 0; i < 5; i++)
				expect((await signIn(WRONG, '198.51.100.9', true)).status).toBe(401);
			expect((await signIn(RIGHT, '198.51.100.9', true)).status).toBe(429);
		});

		it('counts IPv6 addresses in one /64 together', async () => {
			for (let i = 0; i < 5; i++)
				expect((await signIn(WRONG, `2001:db8:1:2::${(i + 1).toString(16)}`)).status).toBe(401);
			expect((await signIn(RIGHT, '2001:db8:1:2:ffff:eeee:dddd:cccc')).status).toBe(429);
			expect((await signIn(RIGHT, '2001:db8:1:3::1')).status).toBe(200);
		});

		it('keeps the PIN lock on the account, from any address on family devices', async () => {
			await identity.admin.setPin({ memberId: 'member_a', pin: '1234', displayName: 'P' });
			for (let i = 0; i < 5; i++)
				expect(
					(await post('/sign-in/pin', { memberId: 'member_a', pin: '0000' }, `2001:db8:9:${i}::1`))
						.status,
				).toBe(401);
			expect(
				(await post('/sign-in/pin', { memberId: 'member_a', pin: '1234' }, '2001:db8:a::1')).status,
			).toBe(429);
			// The password is a separate account key: wrong PINs do not lock it.
			expect((await signIn(RIGHT, '198.51.100.4')).status).toBe(200);
		});
	});
});
