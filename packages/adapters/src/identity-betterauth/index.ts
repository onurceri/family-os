import { type DbExecutor, FamosError, type IdentityAdmin } from '@famos/sdk';
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { sql } from 'kysely';
import { z } from 'zod';
import { addressKey } from './address.ts';
import { createAddressLimit, createLockout } from './limits.ts';

/**
 * Identity adapter on better-auth.
 * - Adults: email + password (public sign-up disabled; admins create logins).
 * - Children / shared devices: member + PIN via the `famos-pin` plugin.
 * - better-auth users are linked 1:1 to core members through `member_id`.
 * - Tables are created by our committed migrations (./migrations.ts), never at runtime.
 * - Telemetry is disabled explicitly.
 */
export interface IdentityOptions {
	db: DbExecutor;
	/** At least 32 random characters; signs session cookies. */
	secret: string;
	/** Public origin, e.g. https://family.example.com */
	baseURL: string;
	trustedOrigins?: string[];
	/** Set false for plain-HTTP LAN/dev setups (cookies without the Secure flag). */
	secureCookies?: boolean;
	/** Silence better-auth's own logger (OpenAPI generation, tests). */
	quiet?: boolean;
	/**
	 * The trusted family device a request comes from, or null. PIN sign-in is refused otherwise, so
	 * a short PIN can never be guessed from outside the home. PIN sessions remember the
	 * device, so revoking it ends them.
	 */
	trustedDevice: (headers: Headers) => Promise<string | null>;
	/**
	 * Whether the member's current role signs in with a PIN. Checked on every PIN
	 * sign-in, so a PIN set earlier stops working when the role changes.
	 */
	mayUsePin: (memberId: string) => Promise<boolean>;
	/**
	 * Replaces better-auth's password hashing (scrypt, tuned to take tens of milliseconds and
	 * a lot of memory). Production leaves it unset; tests pass a cheap hash so sign-in speed
	 * does not depend on how busy the machine is.
	 */
	passwordHasher?: {
		hash: (password: string) => Promise<string>;
		verify: (input: { hash: string; password: string }) => Promise<boolean>;
	};
	/** The clock the sign-in locks read; tests pass a fake one. */
	now?: () => number;
}

export interface Identity {
	/** Handles `/api/auth/*`. */
	handler(request: Request): Promise<Response>;
	/** Returns the member behind the session cookie, or null. */
	resolveMember(
		headers: Headers,
	): Promise<{ memberId: string; sessionId: string; deviceId: string | null } | null>;
	readonly admin: IdentityAdmin;
	/**
	 * Checks a signed-in member's password again before something only they should do (saving the
	 * server's key file). Wrong passwords count against the same locks as signing in: this member
	 * from this address, the account as a whole, and the address across accounts.
	 */
	confirmPassword(
		memberId: string,
		password: string,
		address: string,
	): Promise<{ result: 'ok' | 'wrong' } | { result: 'locked'; retryAfter: number }>;
	/** The underlying options, used to generate migrations. */
	readonly options: BetterAuthOptions;
}

/**
 * The client address, set by the HTTP layer from the socket (or a trusted proxy). better-auth's
 * rate limiter reads only this header, so a client cannot pick its own address.
 */
export const CLIENT_IP_HEADER = 'x-famos-client-ip';
/**
 * Set to `1` by the HTTP layer when a password sign-in comes from a device the family already
 * knows: a family device, or a browser that signed in to the same account before. Like the client
 * address it is removed from every incoming request first, so a client cannot claim it.
 */
export const KNOWN_DEVICE_HEADER = 'x-famos-known-device';
/**
 * Wrong secrets for one account from one address before that address is locked out of the
 * account, and for how long. A PIN (only ever tried on family devices) locks the whole account
 * after the same count, from any address.
 */
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;
/**
 * The account-wide backstop for passwords: wrong passwords from all addresses together in an hour
 * before devices the family does not know are refused for an hour. One address alone is held to
 * 5 per 15 minutes by the lock above, so this only trips on a guess spread over many addresses,
 * and it caps such a guess at about 20 tries an hour. It never refuses a known device, so a
 * stranger who trips it does not keep the person out.
 */
const BACKSTOP_AFTER = 20;
const BACKSTOP_WINDOW_MS = 60 * 60_000;
const BACKSTOP_LOCK_MS = 60 * 60_000;
/**
 * Wrong PINs or passwords one address may send in a window, across all accounts. The per-account
 * lock stops guessing one secret; this stops one device from walking through every account.
 */
const FAILURES_PER_ADDRESS = 10;
const ADDRESS_WINDOW_MS = 60_000;

const CHILD_EMAIL_DOMAIN = 'child.famos.invalid';
const PIN_PROVIDER = 'pin';
const CREDENTIAL_PROVIDER = 'credential';
/** More logins than any household has; better-auth lists only 100 rows unless told otherwise. */
const MAX_LOGINS = 10_000;

type AuthUser = { id: string; email: string; name: string; memberId: string };

function pinPlugin(
	options: Pick<IdentityOptions, 'trustedDevice' | 'mayUsePin'>,
): BetterAuthPlugin {
	const { trustedDevice, mayUsePin } = options;
	return {
		id: 'famos-pin',
		endpoints: {
			signInPin: createAuthEndpoint(
				'/sign-in/pin',
				{
					method: 'POST',
					body: z.object({ memberId: z.string().min(1), pin: z.string().regex(/^\d{4,6}$/) }),
				},
				async (ctx) => {
					const deviceId = ctx.headers ? await trustedDevice(ctx.headers) : null;
					if (!deviceId) {
						throw new APIError('FORBIDDEN', {
							message: 'PIN sign-in is only available on family devices',
							code: 'UNTRUSTED_DEVICE',
						});
					}
					const user = await ctx.context.adapter.findOne<AuthUser>({
						model: 'user',
						where: [{ field: 'memberId', value: ctx.body.memberId }],
					});
					const accounts = user ? await ctx.context.internalAdapter.findAccounts(user.id) : [];
					const hash = accounts.find((a) => a.providerId === PIN_PROVIDER)?.password;
					// Always run a verification so response time does not reveal whether a PIN exists.
					const valid = await ctx.context.password.verify({
						password: ctx.body.pin,
						hash: hash ?? (await ctx.context.password.hash('0000-dummy')),
					});
					// A role without PIN sign-in gets the same answer as a wrong PIN: nothing to learn.
					if (!user || !hash || !valid || !(await mayUsePin(ctx.body.memberId)))
						throw new APIError('UNAUTHORIZED', { message: 'Invalid PIN' });
					const session = await ctx.context.internalAdapter.createSession(user.id, false, {
						deviceId,
					});
					await setSessionCookie(ctx, { session, user: user as never });
					return ctx.json({ ok: true });
				},
			),
		},
	};
}

export function authOptions(options: IdentityOptions): BetterAuthOptions {
	return {
		appName: 'FamilyOS',
		baseURL: options.baseURL,
		basePath: '/api/auth',
		secret: options.secret,
		trustedOrigins: options.trustedOrigins ?? [options.baseURL],
		database: { db: options.db, type: 'sqlite', casing: 'snake' },
		telemetry: { enabled: false },
		emailAndPassword: {
			enabled: true,
			disableSignUp: true,
			minPasswordLength: 10,
			maxPasswordLength: 200,
			...(options.passwordHasher && { password: options.passwordHasher }),
		},
		user: {
			modelName: 'auth_users',
			additionalFields: {
				memberId: { type: 'string', required: true, unique: true, input: false },
			},
		},
		session: {
			modelName: 'auth_sessions',
			expiresIn: 60 * 60 * 24 * 30,
			updateAge: 60 * 60 * 24,
			// Set by PIN sign-in only; revoking the device ends these sessions.
			additionalFields: { deviceId: { type: 'string', required: false, input: false } },
		},
		account: { modelName: 'auth_accounts' },
		verification: { modelName: 'auth_verifications' },
		rateLimit: {
			enabled: true,
			storage: 'memory',
			window: 60,
			max: 100,
			// better-auth counts every request, successful ones too: on one kitchen tablet a few
			// children switching profiles would be refused. PIN sign-in is limited by its wrong PINs
			// instead (per account and per address, in `createIdentity`); so is password sign-in, since
			// a family behind one router shares an address and would hit the same few-per-seconds rule.
			customRules: { '/sign-in/pin': false, '/sign-in/email': false },
		},
		advanced: {
			ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
			useSecureCookies: options.secureCookies ?? options.baseURL.startsWith('https://'),
			// Our migrations own the schema. better-auth's runtime check would run before they apply on
			// first start and cache the mismatch; test/identity.test.ts verifies the schema instead.
			database: { validateSchema: false },
		},
		...(options.quiet && { logger: { disabled: true } }),
		plugins: [pinPlugin(options)],
	};
}

export function createIdentity(options: IdentityOptions): Identity {
	if (options.secret.length < 32) throw new Error('FAMOS_SECRET must be at least 32 characters');
	const config = authOptions(options);
	const auth = betterAuth(config);

	const context = () => auth.$context;
	const now = options.now ?? Date.now;
	// Per (account, address) for passwords; per account for PINs, which only family devices send.
	const lockout = createLockout({ after: LOCK_AFTER, lockMs: LOCK_MS, now });
	const backstop = createLockout({
		after: BACKSTOP_AFTER,
		windowMs: BACKSTOP_WINDOW_MS,
		lockMs: BACKSTOP_LOCK_MS,
		now,
	});
	const addressFailures = createAddressLimit({
		max: FAILURES_PER_ADDRESS,
		windowMs: ADDRESS_WINDOW_MS,
		now,
	});
	const findUser = async (memberId: string) =>
		(await context()).adapter.findOne<AuthUser>({
			model: 'user',
			where: [{ field: 'memberId', value: memberId }],
		});

	async function ensureUser(
		memberId: string,
		email: string,
		displayName: string,
	): Promise<AuthUser> {
		const ctx = await context();
		const existing = await findUser(memberId);
		const owner = await ctx.internalAdapter.findUserByEmail(email);
		if (owner && owner.user.id !== existing?.id)
			throw new FamosError('conflict', 'Email is already used by another member', {
				reason: 'email_taken',
			});
		if (existing) {
			if (existing.email !== email || existing.name !== displayName) {
				await ctx.internalAdapter.updateUser(existing.id, { email, name: displayName });
			}
			return { ...existing, email, name: displayName };
		}
		return ctx.internalAdapter.createUser<AuthUser>(
			{ email, name: displayName, emailVerified: true, memberId },
			{ method: 'admin' },
		);
	}

	async function upsertSecret(userId: string, providerId: string, secret: string) {
		const ctx = await context();
		const hash = await ctx.password.hash(secret);
		const account = (await ctx.internalAdapter.findAccounts(userId)).find(
			(a) => a.providerId === providerId,
		);
		if (account) await ctx.internalAdapter.updateAccount(account.id, { password: hash });
		else
			await ctx.internalAdapter.createAccount({
				userId,
				providerId,
				accountId: userId,
				password: hash,
			});
	}

	const admin: IdentityAdmin = {
		async setPasswordLogin({ memberId, email, password, displayName }) {
			const user = await ensureUser(memberId, email.toLowerCase(), displayName);
			await upsertSecret(user.id, CREDENTIAL_PROVIDER, password);
		},
		async setPin({ memberId, pin, displayName }) {
			const existing = await findUser(memberId);
			const user =
				existing ?? (await ensureUser(memberId, `${memberId}@${CHILD_EMAIL_DOMAIN}`, displayName));
			await upsertSecret(user.id, PIN_PROVIDER, pin);
		},
		async signInMethods() {
			const ctx = await context();
			const users = await ctx.adapter.findMany<AuthUser>({ model: 'user', limit: MAX_LOGINS });
			const memberOf = new Map(users.map((u) => [u.id, u.memberId]));
			const accounts = users.length
				? await ctx.adapter.findMany<{ userId: string; providerId: string }>({
						model: 'account',
						where: [{ field: 'userId', operator: 'in', value: [...memberOf.keys()] }],
						limit: MAX_LOGINS * 2,
					})
				: [];
			const methods = new Map<string, { password: boolean; pin: boolean }>();
			for (const account of accounts) {
				const memberId = memberOf.get(account.userId);
				if (!memberId) continue;
				const entry = methods.get(memberId) ?? { password: false, pin: false };
				if (account.providerId === CREDENTIAL_PROVIDER) entry.password = true;
				if (account.providerId === PIN_PROVIDER) entry.pin = true;
				methods.set(memberId, entry);
			}
			return methods;
		},
		async endSessions(memberId) {
			const user = await findUser(memberId);
			if (user) await (await context()).internalAdapter.deleteUserSessions(user.id);
		},
		async endDeviceSessions(deviceId) {
			await (await context()).adapter.deleteMany({
				model: 'session',
				where: [{ field: 'deviceId', value: deviceId }],
			});
		},
		async endAllSessions() {
			await sql`delete from auth_sessions`.execute(options.db);
		},
		async carryNewerLogins(previous) {
			const at = (value: unknown) =>
				typeof value === 'number' ? value : Date.parse(String(value));
			type Account = { id: string; password: string | null; updatedAt: unknown };
			type Earlier = Account & { userId: string; providerId: string; memberId: string };
			let before: Earlier[];
			try {
				// Only logins both databases know: same login, same member.
				before = (
					await sql<Earlier>`
						select a.id, a."userId", a."providerId", a.password, a."updatedAt", u."memberId"
						from auth_accounts a join auth_users u on u.id = a."userId"
						where a.password is not null`.execute(previous)
				).rows;
			} catch (error) {
				if (/no such (table|column)/i.test(String(error))) return 0;
				throw error;
			}
			const memberOf = new Map(
				(
					await sql<{
						id: string;
						memberId: string;
					}>`select id, "memberId" from auth_users`.execute(options.db)
				).rows.map((u) => [u.id, u.memberId]),
			);
			let carried = 0;
			for (const account of before) {
				if (memberOf.get(account.userId) !== account.memberId) continue;
				const now = (
					await sql<Account>`select id, password, "updatedAt" from auth_accounts
						where "userId" = ${account.userId} and "providerId" = ${account.providerId}`.execute(
						options.db,
					)
				).rows[0];
				if (!now || now.password === account.password) continue;
				if (at(account.updatedAt) <= at(now.updatedAt)) continue;
				await sql`update auth_accounts set password = ${account.password}, "updatedAt" = ${account.updatedAt}
					where id = ${now.id}`.execute(options.db);
				carried += 1;
			}
			return carried;
		},
		async revokeAll(memberId) {
			const user = await findUser(memberId);
			if (!user) return;
			const ctx = await context();
			await ctx.internalAdapter.deleteUserSessions(user.id);
			await ctx.internalAdapter.deleteAccounts(user.id);
			await ctx.internalAdapter.deleteUser(user.id);
		},
	};

	return {
		async confirmPassword(memberId, password, address) {
			const ctx = await context();
			const user = await findUser(memberId);
			const key = addressKey(address);
			const account = `email:${(user?.email ?? memberId).toLowerCase()}`;
			const lockKey = `${account}|${key}`;
			const sender = `email:${key}`;
			const waitMs = Math.max(
				lockout.lockedFor(lockKey),
				backstop.lockedFor(account),
				addressFailures.waitFor(sender),
			);
			if (waitMs > 0) return { result: 'locked', retryAfter: Math.ceil(waitMs / 1000) };
			const accounts = user ? await ctx.internalAdapter.findAccounts(user.id) : [];
			const hash = accounts.find((a) => a.providerId === CREDENTIAL_PROVIDER)?.password;
			// Always run a verification so response time does not reveal whether a password exists.
			const valid = await ctx.password.verify({
				password,
				hash: hash ?? (await ctx.password.hash('dummy-password')),
			});
			const ok = valid && Boolean(hash);
			lockout.record(lockKey, ok);
			if (!ok) {
				backstop.record(account, false);
				addressFailures.fail(sender);
			}
			return { result: ok ? 'ok' : 'wrong' };
		},
		async handler(request) {
			const target = await signInTarget(request);
			if (!target) return auth.handler(request);
			const ip = request.headers.get(CLIENT_IP_HEADER);
			const address = ip ? addressKey(ip) : 'unknown';
			const account = `${target.kind}:${target.id}`;
			// A password locks the guesser (this address, for this account), never the person; a PIN
			// is only tried on family devices, so its lock stays on the account.
			const lockKey = target.kind === 'pin' ? account : `${account}|${address}`;
			const known = target.kind === 'email' && request.headers.get(KNOWN_DEVICE_HEADER) === '1';
			const lockedMs = Math.max(
				lockout.lockedFor(lockKey),
				target.kind === 'email' && !known ? backstop.lockedFor(account) : 0,
			);
			if (lockedMs > 0) {
				// The wait comes from here, so the sign-in screen never states a duration of its own.
				const retryAfter = Math.ceil(lockedMs / 1000);
				return Response.json(
					{ code: 'LOCKED', message: 'Too many failed attempts. Try again later.', retryAfter },
					{ status: 429, headers: { 'retry-after': String(retryAfter) } },
				);
			}
			const sender = ip ? `${target.kind}:${address}` : null;
			const waitMs = sender ? addressFailures.waitFor(sender) : 0;
			if (waitMs > 0) {
				const retryAfter = Math.ceil(waitMs / 1000);
				return Response.json(
					{ code: 'RATE_LIMITED', message: 'Too many tries from this device.', retryAfter },
					{ status: 429, headers: { 'retry-after': String(retryAfter) } },
				);
			}
			const response = await auth.handler(request);
			// Only a sign-in that checked the secret and found it wrong is a failure. A refusal before
			// that (a device that is not a family device, a malformed request) says nothing about the
			// secret, and must not lock a child out of the family tablet.
			const failed = response.status === 401;
			if (failed || response.ok) lockout.record(lockKey, response.ok);
			// The backstop forgets only with time: a right password from one place does not hand a
			// distributed guesser a fresh budget.
			if (failed && target.kind === 'email') backstop.record(account, false);
			if (sender && failed) addressFailures.fail(sender);
			return response;
		},
		async resolveMember(headers) {
			const result = await auth.api.getSession({ headers });
			if (!result) return null;
			const memberId = (result.user as unknown as AuthUser).memberId;
			const deviceId = (result.session as { deviceId?: string | null }).deviceId ?? null;
			return memberId ? { memberId, sessionId: result.session.id, deviceId } : null;
		},
		admin,
		options: config,
	};
}

/**
 * The account a sign-in attempt names: an email (lowercased) or a member id for a PIN. Null for
 * anything that is not a sign-in.
 */
export async function signInTarget(
	request: Request,
): Promise<{ kind: 'email' | 'pin'; id: string } | null> {
	if (request.method !== 'POST') return null;
	const path = new URL(request.url).pathname;
	const kind = path.endsWith('/sign-in/pin')
		? 'pin'
		: path.endsWith('/sign-in/email')
			? 'email'
			: null;
	if (!kind) return null;
	try {
		const body = (await request.clone().json()) as { memberId?: unknown; email?: unknown };
		const id = kind === 'pin' ? body.memberId : body.email;
		return typeof id === 'string' && id ? { kind, id: id.toLowerCase() } : null;
	} catch {
		return null;
	}
}

export { addressKey } from './address.ts';
export { identityMigrations } from './migrations.ts';
