import { type DbExecutor, FamosError, type IdentityAdmin } from '@famos/sdk';
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';

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
}

export interface Identity {
	/** Handles `/api/auth/*`. */
	handler(request: Request): Promise<Response>;
	/** Returns the member behind the session cookie, or null. */
	resolveMember(
		headers: Headers,
	): Promise<{ memberId: string; sessionId: string; deviceId: string | null } | null>;
	readonly admin: IdentityAdmin;
	/** The underlying options, used to generate migrations. */
	readonly options: BetterAuthOptions;
}

/**
 * The client address, set by the HTTP layer from the socket (or a trusted proxy). better-auth's
 * rate limiter reads only this header, so a client cannot pick its own address.
 */
export const CLIENT_IP_HEADER = 'x-famos-client-ip';
/** Failed sign-ins per account before it is locked, and for how long. */
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;

const CHILD_EMAIL_DOMAIN = 'child.famos.invalid';
const PIN_PROVIDER = 'pin';
const CREDENTIAL_PROVIDER = 'credential';

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
		rateLimit: [{ pathMatcher: (path) => path === '/sign-in/pin', window: 60, max: 5 }],
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
		rateLimit: { enabled: true, storage: 'memory', window: 60, max: 100 },
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
	const lockout = createLockout();
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
		async handler(request) {
			const key = await signInKey(request);
			const lockedMs = key ? lockout.lockedFor(key) : 0;
			if (key && lockedMs > 0) {
				// The wait comes from here, so the sign-in screen never states a duration of its own.
				const retryAfter = Math.ceil(lockedMs / 1000);
				return Response.json(
					{ code: 'LOCKED', message: 'Too many failed attempts. Try again later.', retryAfter },
					{ status: 429, headers: { 'retry-after': String(retryAfter) } },
				);
			}
			const response = await auth.handler(request);
			if (key) lockout.record(key, response.ok);
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

/** The account a sign-in attempt targets, for the per-account lockout. */
async function signInKey(request: Request): Promise<string | null> {
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
		return typeof id === 'string' && id ? `${kind}:${id.toLowerCase()}` : null;
	} catch {
		return null;
	}
}

/**
 * Locks an account after repeated failures, whatever address they come from (the IP rate limit
 * alone does not stop a slow, distributed guess at a 4-digit PIN). In memory: a restart clears it,
 * which is acceptable for a single family server.
 */
function createLockout(now: () => number = Date.now) {
	const failures = new Map<string, { count: number; until: number }>();
	return {
		/** Milliseconds left on the lock, or 0 when the account is not locked. */
		lockedFor(key: string) {
			const entry = failures.get(key);
			if (!entry || entry.until <= now()) {
				if (entry?.until) failures.delete(key);
				return 0;
			}
			return entry.until - now();
		},
		record(key: string, ok: boolean) {
			if (ok) {
				failures.delete(key);
				return;
			}
			const entry = failures.get(key) ?? { count: 0, until: 0 };
			entry.count += 1;
			if (entry.count >= LOCK_AFTER) {
				entry.count = 0;
				entry.until = now() + LOCK_MS;
			}
			failures.set(key, entry);
		},
	};
}

export { identityMigrations } from './migrations.ts';
