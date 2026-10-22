import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { OAUTH_REFRESH_GRACE_MS } from '@famos/core';
import {
	auth,
	type OAuthClientProvider,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { admits, DOOR_KINDS } from '../src/http/authenticate.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const BASE = 'http://localhost:3000';
const MCP = `${BASE}/mcp`;
const HA_REDIRECT = 'https://my.home-assistant.io/redirect/oauth';
const APP_REDIRECT = 'https://app.example/callback';
const PASSWORD = 'correct horse battery';
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;

async function boot() {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-oauth-'));
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
		trustedProxies: ['127.0.0.1'],
	});
}
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-19T07:00:00Z') });
	return boot();
});
afterEach(() => {
	vi.useRealTimers();
	return runtime.close();
});

let ip = 0;
const nextIp = () => `10.7.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;

/** The session API, the way the app calls it (origin check included). */
async function call(method: string, path: string, body?: unknown, cookie?: string) {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			'x-forwarded-for': nextIp(),
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(cookie && { cookie }),
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return {
		status: res.status,
		headers: res.headers,
		body: text?.startsWith('{') ? JSON.parse(text) : text,
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('base64url');
const pkce = () => {
	const verifier = randomBytes(32).toString('base64url');
	return { verifier, challenge: sha256(verifier) };
};

async function setupFamily() {
	const setupRes = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: PASSWORD,
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	expect(setupRes.status).toBe(201);
	const signIn = await call('POST', '/api/auth/sign-in/email', {
		email: 'parent@example.com',
		password: PASSWORD,
	});
	const cookie = signIn.cookie;
	return { adminId: setupRes.body.id as string, cookie };
}

/** MCP on and AI apps allowed to sign in (on the plain http test address). */
async function turnOn(cookie: string, patch: object = {}) {
	const mcp = await call('POST', '/api/v1/actions/core.setMcpEnabled', { enabled: true }, cookie);
	expect(mcp.body.status).toBe('applied');
	const oauth = await call(
		'POST',
		'/api/v1/actions/core.setMcpOAuth',
		{ oauthEnabled: true, allowPlainHttp: true, ...patch },
		cookie,
	);
	expect(oauth.body.status).toBe('applied');
}

async function addMember(cookie: string, displayName: string, roleId = 'member') {
	const res = await call(
		'POST',
		'/api/v1/actions/core.createMember',
		{ displayName, roleId },
		cookie,
	);
	expect(res.body.status).toBe('applied');
	const id = res.body.output.id as string;
	await call(
		'PUT',
		`/api/v1/core/members/${id}/password`,
		{ email: `${displayName.toLowerCase()}@example.com`, password: PASSWORD },
		cookie,
	);
	return id;
}

async function signInAs(displayName: string) {
	const res = await call('POST', '/api/auth/sign-in/email', {
		email: `${displayName.toLowerCase()}@example.com`,
		password: PASSWORD,
	});
	expect(res.status).toBe(200);
	return res.cookie;
}

/** An app a member set up (Home Assistant's way): id and secret, shown once. */
async function registerApp(
	cookie: string,
	body: object = { name: 'Notes', redirectUris: [APP_REDIRECT, 'http://localhost:7000/cb'] },
) {
	const res = await call('POST', '/api/v1/mcp/oauth-clients', body, cookie);
	expect(res.status).toBe(201);
	return {
		clientId: res.body.client.clientId as string,
		secret: res.body.clientSecret as string,
		body: res.body,
	};
}

/** A public app (no secret), as an app that registered itself would be. */
async function publicApp(redirectUris: string[] = [APP_REDIRECT, 'http://localhost:7000/cb']) {
	const id = `oauth_client_public${++ip}`;
	await runtime.handle.db
		.insertInto('core_oauth_clients' as never)
		.values({
			id,
			kind: 'dynamic',
			client_id: id,
			name: 'Browser helper',
			redirect_uris: JSON.stringify(redirectUris),
			secret_hash: null,
			require_pkce: 1,
			owner_member_id: null,
			created_at: Date.now(),
			last_consented_at: null,
			metadata_fetched_at: null,
			metadata_etag: null,
			revoked_at: null,
		} as never)
		.execute();
	return id;
}

type Params = Record<string, string | undefined>;

/** A browser opening the authorization link: nothing is followed. */
async function authorize(params: Params, headers: Record<string, string> = {}) {
	const url = new URL(`${BASE}/oauth/authorize`);
	for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
	const res = await app.request(url, {
		redirect: 'manual',
		headers: { 'x-forwarded-for': nextIp(), ...headers },
	});
	return { status: res.status, headers: res.headers, location: res.headers.get('location'), res };
}

const requestIdOf = (location: string | null) => {
	const match = /^http:\/\/localhost:3000\/connect\/([A-Za-z0-9_-]+)$/.exec(location ?? '');
	expect(match).not.toBeNull();
	return match?.[1] as string;
};

const outcomeOf = (redirectUrl: string): Record<string, string | undefined> => {
	const url = new URL(redirectUrl);
	return Object.fromEntries(url.searchParams);
};

/** Opens the link and approves it as the signed-in person; returns what the app gets back. */
async function connect(cookie: string, params: Params, scope?: 'read' | 'read_write') {
	const opened = await authorize(params);
	expect(opened.status).toBe(303);
	const id = requestIdOf(opened.location);
	const decided = await call(
		'POST',
		`/api/v1/oauth/requests/${id}/approve`,
		scope ? { scope } : {},
		cookie,
	);
	expect(decided.status).toBe(200);
	const answer = outcomeOf(decided.body.redirectUrl as string);
	return {
		id,
		redirectUrl: decided.body.redirectUrl as string,
		code: answer.code as string,
		state: answer.state as string,
		iss: answer.iss as string,
	};
}

/** The token endpoint, the way an app calls it. */
async function token(
	form: Params,
	options: { basic?: [string, string]; ip?: string; contentType?: string; body?: string } = {},
) {
	const body = new URLSearchParams();
	for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, v);
	const res = await app.request(`${BASE}/oauth/token`, {
		method: 'POST',
		headers: {
			'content-type': options.contentType ?? 'application/x-www-form-urlencoded',
			'x-forwarded-for': options.ip ?? nextIp(),
			...(options.basic && {
				authorization: `Basic ${Buffer.from(
					`${encodeURIComponent(options.basic[0])}:${encodeURIComponent(options.basic[1])}`,
				).toString('base64')}`,
			}),
		},
		body: options.body ?? body.toString(),
	});
	const text = await res.text();
	return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/** A raw JSON-RPC call to `/mcp`. */
async function rpc(secret: string | null, ip = '10.9.0.1') {
	const res = await app.request(MCP, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			'x-forwarded-for': ip,
			...(secret && { authorization: `Bearer ${secret}` }),
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
	});
	await res.text();
	return { status: res.status, headers: res.headers };
}

const codeFlow = async (cookie: string, secret: string, clientId: string) => {
	const { verifier, challenge } = pkce();
	const back = await connect(cookie, {
		response_type: 'code',
		client_id: clientId,
		redirect_uri: APP_REDIRECT,
		state: 'xyz',
		code_challenge: challenge,
		code_challenge_method: 'S256',
		resource: MCP,
	});
	const tokens = await token({
		grant_type: 'authorization_code',
		code: back.code,
		redirect_uri: APP_REDIRECT,
		code_verifier: verifier,
		client_id: clientId,
		client_secret: secret,
		resource: MCP,
	});
	expect(tokens.status).toBe(200);
	return {
		access: tokens.body.access_token as string,
		refresh: tokens.body.refresh_token as string,
		body: tokens.body,
		back,
	};
};

describe('the oauth door', () => {
	it('admits no caller', () => {
		expect(DOOR_KINDS.oauth).toEqual([]);
		for (const actor of [
			{ kind: 'member', memberId: 'm', roleId: 'admin' },
			{ kind: 'ai', mode: 'agent', source: 'mcp', onBehalfOf: 'm', roleId: 'admin' },
			{ kind: 'app', appId: 'a' },
			{ kind: 'display', deviceId: 'd' },
			{ kind: 'system', source: 's' },
		])
			expect(admits('oauth', actor as never)).toBe(false);
	});
});

describe('metadata', () => {
	it('describes the resource and the authorization server from the family address only', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		// A forged Host or forwarded host moves nothing: the issuer is the configured address.
		const headers = { host: 'evil.example', 'x-forwarded-host': 'evil.example' };
		for (const path of [
			'/.well-known/oauth-protected-resource/mcp',
			'/.well-known/oauth-protected-resource',
		]) {
			const res = await app.request(`${BASE}${path}`, { headers });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				resource: MCP,
				authorization_servers: [BASE],
				scopes_supported: ['familyos.read', 'familyos.suggest'],
				bearer_methods_supported: ['header'],
			});
			expect(res.headers.get('access-control-allow-origin')).toBe('*');
			expect(res.headers.get('access-control-allow-credentials')).toBeNull();
		}
		const res = await app.request(`${BASE}/.well-known/oauth-authorization-server`, { headers });
		expect(res.status).toBe(200);
		const doc = (await res.json()) as Record<string, unknown>;
		expect(doc).toEqual({
			issuer: BASE,
			authorization_endpoint: `${BASE}/oauth/authorize`,
			token_endpoint: `${BASE}/oauth/token`,
			revocation_endpoint: `${BASE}/oauth/revoke`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
			authorization_response_iss_parameter_supported: true,
			scopes_supported: ['familyos.read', 'familyos.suggest'],
		});
		expect(doc.registration_endpoint).toBeUndefined();
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(JSON.stringify(doc)).not.toContain('evil.example');
	});

	it('answers a browser’s preflight for the token and revoke endpoints', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		for (const path of ['/oauth/token', '/oauth/revoke']) {
			const res = await app.request(`${BASE}${path}`, {
				method: 'OPTIONS',
				headers: {
					origin: 'https://inspector.example',
					'access-control-request-method': 'POST',
					'access-control-request-headers': 'content-type,authorization',
				},
			});
			expect(res.status).toBe(204);
			expect(res.headers.get('access-control-allow-origin')).toBe('*');
			expect(res.headers.get('access-control-allow-credentials')).toBeNull();
		}
	});

	it('is not there while signing in is off, or MCP is', async () => {
		const { cookie } = await setupFamily();
		const everywhere = async () => {
			const seen: number[] = [];
			for (const path of [
				'/.well-known/oauth-protected-resource/mcp',
				'/.well-known/oauth-protected-resource',
				'/.well-known/oauth-authorization-server',
				'/oauth/authorize?client_id=x',
			])
				seen.push((await app.request(`${BASE}${path}`)).status);
			for (const path of ['/oauth/token', '/oauth/revoke'])
				seen.push(
					(
						await app.request(`${BASE}${path}`, {
							method: 'POST',
							headers: { 'content-type': 'application/x-www-form-urlencoded' },
							body: 'token=x',
						})
					).status,
				);
			seen.push((await call('GET', '/api/v1/oauth/requests/abc', undefined, cookie)).status);
			return seen;
		};
		// Off from the start.
		expect(await everywhere()).toEqual(Array(7).fill(404));
		await turnOn(cookie);
		expect((await everywhere()).filter((s) => s === 404)).toEqual([]);
		// MCP off again: signing in stops with it.
		const off = await call(
			'POST',
			'/api/v1/actions/core.setMcpEnabled',
			{ enabled: false },
			cookie,
		);
		expect(off.body.status).toBe('applied');
		expect(await everywhere()).toEqual(Array(7).fill(404));
		// And OAuth off with MCP on.
		await turnOn(cookie, { oauthEnabled: false });
		expect(await everywhere()).toEqual(Array(7).fill(404));
	});
});

describe('a standard client', () => {
	/** An app built on the MCP SDK's own sign-in helper, with its state kept in memory. */
	function provider(info: StoredOAuthClientInformation) {
		let verifier = '';
		let tokens: StoredOAuthTokens | undefined;
		let authorizationUrl: URL | undefined;
		const redirectUrl = APP_REDIRECT;
		const impl: OAuthClientProvider = {
			get redirectUrl() {
				return redirectUrl;
			},
			get clientMetadata() {
				return {
					client_name: 'Notes',
					redirect_uris: [redirectUrl],
					grant_types: ['authorization_code', 'refresh_token'],
					response_types: ['code'],
					token_endpoint_auth_method: info.client_secret ? 'client_secret_basic' : 'none',
				};
			},
			state: () => 'state-123',
			clientInformation: () => info,
			tokens: () => tokens,
			saveTokens: (t) => {
				tokens = t;
			},
			redirectToAuthorization: (url) => {
				authorizationUrl = url;
			},
			saveCodeVerifier: (v) => {
				verifier = v;
			},
			codeVerifier: () => verifier,
		};
		return {
			impl,
			get tokens() {
				return tokens;
			},
			get url() {
				return authorizationUrl as URL;
			},
		};
	}
	const fetchFn = async (url: string | URL, init?: RequestInit) => app.request(String(url), init);

	async function finish(cookie: string, p: ReturnType<typeof provider>, scope?: 'read') {
		const opened = await app.request(p.url, { redirect: 'manual' });
		expect(opened.status).toBe(303);
		const id = requestIdOf(opened.headers.get('location'));
		const decided = await call(
			'POST',
			`/api/v1/oauth/requests/${id}/approve`,
			scope ? { scope } : {},
			cookie,
		);
		expect(decided.status).toBe(200);
		const back = outcomeOf(decided.body.redirectUrl as string);
		expect(back.state).toBe('state-123');
		expect(back.iss).toBe(BASE);
		return back;
	}

	it('signs a public client in with PKCE, uses the token at /mcp, and refreshes it', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const clientId = await publicApp();
		const p = provider({ client_id: clientId });

		const started = await auth(p.impl, { serverUrl: MCP, fetchFn });
		expect(started).toBe('REDIRECT');
		expect(p.url.pathname).toBe('/oauth/authorize');
		expect(p.url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(p.url.searchParams.get('resource')).toBe(MCP);

		const back = await finish(cookie, p);
		const done = await auth(p.impl, {
			serverUrl: MCP,
			authorizationCode: back.code,
			iss: back.iss,
			fetchFn,
		});
		expect(done).toBe('AUTHORIZED');
		const first = p.tokens as StoredOAuthTokens;
		expect(first.access_token).toMatch(/^famos_at_/);
		expect(first.refresh_token).toMatch(/^famos_rt_/);
		expect(first.token_type?.toLowerCase()).toBe('bearer');
		expect((await rpc(first.access_token)).status).toBe(200);

		// A second call to the helper refreshes with the rotating refresh token.
		vi.setSystemTime(Date.now() + 61 * 60 * 1000);
		expect((await rpc(first.access_token)).status).toBe(401);
		expect(await auth(p.impl, { serverUrl: MCP, fetchFn })).toBe('AUTHORIZED');
		const second = p.tokens as StoredOAuthTokens;
		expect(second.access_token).not.toBe(first.access_token);
		expect(second.refresh_token).not.toBe(first.refresh_token);
		expect((await rpc(second.access_token)).status).toBe(200);
	});

	it('signs a confidential client in with its secret and PKCE', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const made = await registerApp(cookie);
		const p = provider({ client_id: made.clientId, client_secret: made.secret });
		expect(await auth(p.impl, { serverUrl: MCP, fetchFn })).toBe('REDIRECT');
		const back = await finish(cookie, p);
		expect(
			await auth(p.impl, { serverUrl: MCP, authorizationCode: back.code, iss: back.iss, fetchFn }),
		).toBe('AUTHORIZED');
		expect((await rpc((p.tokens as StoredOAuthTokens).access_token)).status).toBe(200);
	});

	it('gives only what the person chose', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const clientId = await publicApp();
		const p = provider({ client_id: clientId });
		await auth(p.impl, { serverUrl: MCP, fetchFn });
		const back = await finish(cookie, p, 'read');
		await auth(p.impl, { serverUrl: MCP, authorizationCode: back.code, iss: back.iss, fetchFn });
		expect((p.tokens as StoredOAuthTokens).scope).toBe('familyos.read');
	});
});

describe('Home Assistant’s way', () => {
	it('signs a confidential client in without PKCE, and refreshes with either secret method', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const made = await registerApp(cookie, {
			preset: 'ha',
			homeAssistantUrl: 'http://homeassistant.local:8123/',
		});
		expect(made.body.client).toMatchObject({
			name: 'Home Assistant',
			kind: 'registered',
			requirePkce: false,
			redirectUris: [HA_REDIRECT, 'http://homeassistant.local:8123/auth/external/callback'],
		});
		expect(made.body.mcpUrl).toBe(MCP);
		expect(made.secret).toMatch(/^famos_cs_/);

		// No PKCE and no resource; it asks for offline access and a consent screen.
		const back = await connect(cookie, {
			response_type: 'code',
			client_id: made.clientId,
			redirect_uri: HA_REDIRECT,
			state: 'ha-state',
			scope: 'familyos.read familyos.suggest',
			access_type: 'offline',
			prompt: 'consent',
		});
		expect(back.state).toBe('ha-state');
		expect(back.iss).toBe(BASE);

		// A wrong secret gets nothing, and the right one in the body gets the pair.
		const wrong = await token({
			grant_type: 'authorization_code',
			code: back.code,
			redirect_uri: HA_REDIRECT,
			client_id: made.clientId,
			client_secret: 'famos_cs_wrong',
		});
		expect(wrong.status).toBe(401);
		expect(wrong.body.error).toBe('invalid_client');
		const tokens = await token({
			grant_type: 'authorization_code',
			code: back.code,
			redirect_uri: HA_REDIRECT,
			client_id: made.clientId,
			client_secret: made.secret,
		});
		expect(tokens.status).toBe(200);
		expect(tokens.headers.get('cache-control')).toBe('no-store');
		expect(tokens.body).toMatchObject({
			token_type: 'Bearer',
			expires_in: 3600,
			scope: 'familyos.read familyos.suggest',
		});
		expect((await rpc(tokens.body.access_token)).status).toBe(200);

		const refreshed = await token(
			{ grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token },
			{ basic: [made.clientId, made.secret] },
		);
		expect(refreshed.status).toBe(200);
		expect(refreshed.body.refresh_token).not.toBe(tokens.body.refresh_token);
		const again = await token({
			grant_type: 'refresh_token',
			refresh_token: refreshed.body.refresh_token,
			client_id: made.clientId,
			client_secret: made.secret,
		});
		expect(again.status).toBe(200);
	});

	it('keeps the PKCE exception to Home Assistant’s own preset', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const made = await registerApp(cookie);
		expect(made.body.client.requirePkce).toBe(true);
		const opened = await authorize({
			response_type: 'code',
			client_id: made.clientId,
			redirect_uri: APP_REDIRECT,
			state: 's1',
		});
		// The address is the app’s own, so the refusal goes back to it.
		expect(opened.status).toBe(303);
		expect(outcomeOf(opened.location as string)).toMatchObject({
			error: 'invalid_request',
			state: 's1',
			iss: BASE,
		});
		// The preset refuses return addresses of its own, and a plain app needs them.
		const extra = await call(
			'POST',
			'/api/v1/mcp/oauth-clients',
			{ preset: 'ha', redirectUris: [APP_REDIRECT] },
			cookie,
		);
		expect(extra.status).toBe(400);
		const none = await call('POST', '/api/v1/mcp/oauth-clients', { name: 'x' }, cookie);
		expect(none.status).toBe(400);
	});

	it('shows the secret once and records the set-up without it', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const made = await registerApp(cookie);
		const rows = await runtime.handle.db
			.selectFrom('core_audit_log' as never)
			.select(['action_id', 'target'] as never[])
			.execute();
		expect(rows).toContainEqual({
			action_id: 'core.oauth.registerClient',
			target: expect.any(String),
		});
		expect(JSON.stringify(rows)).not.toContain(made.secret);
		const stored = await runtime.handle.db
			.selectFrom('core_oauth_clients' as never)
			.selectAll()
			.execute();
		expect(JSON.stringify(stored)).not.toContain(made.secret);
	});
});

describe('authorization requests', () => {
	it('never redirects for an unknown app or a return address it did not register', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const made = await registerApp(cookie);
		const { challenge } = pkce();
		const base = {
			response_type: 'code',
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state: 's',
		};
		const cases: Params[] = [
			{ ...base, client_id: 'nobody', redirect_uri: APP_REDIRECT },
			{ ...base, client_id: made.clientId, redirect_uri: 'https://evil.example/cb' },
			{ ...base, client_id: made.clientId, redirect_uri: `${APP_REDIRECT}/` },
			{ ...base, client_id: made.clientId, redirect_uri: 'https://app.example/callback?x=1' },
			{ ...base, client_id: made.clientId },
			{ ...base, redirect_uri: APP_REDIRECT },
		];
		for (const params of cases) {
			const res = await authorize(params);
			expect(res.status).toBe(400);
			expect(res.location).toBeNull();
			expect(res.headers.get('content-type')).toMatch(/text\/html/);
			expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
		}
		// The same app and address with a repeated parameter is unreadable, not redirected.
		const url = `${BASE}/oauth/authorize?client_id=${made.clientId}&client_id=other&redirect_uri=${encodeURIComponent(APP_REDIRECT)}`;
		expect((await app.request(url, { redirect: 'manual' })).status).toBe(400);
	});

	it('sends later problems back to the app with the state and the issuer', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const clientId = await publicApp();
		const { challenge } = pkce();
		const good = {
			response_type: 'code',
			client_id: clientId,
			redirect_uri: APP_REDIRECT,
			state: 'keep-me',
			code_challenge: challenge,
			code_challenge_method: 'S256',
		};
		const wrong: [string, Params][] = [
			['unsupported_response_type', { ...good, response_type: 'token' }],
			['invalid_request', { ...good, code_challenge_method: 'plain' }],
			['invalid_request', { ...good, code_challenge_method: undefined }],
			['invalid_request', { ...good, code_challenge: undefined }],
			['invalid_target', { ...good, resource: 'https://other.example/mcp' }],
			['invalid_request', { ...good, state: 's'.repeat(2000) }],
		];
		for (const [error, params] of wrong) {
			const res = await authorize(params);
			expect(res.status).toBe(303);
			const back = new URL(res.location as string);
			expect(`${back.origin}${back.pathname}`).toBe(APP_REDIRECT);
			expect(back.searchParams.get('error')).toBe(error);
			expect(back.searchParams.get('iss')).toBe(BASE);
			if (params.state === 'keep-me') expect(back.searchParams.get('state')).toBe('keep-me');
		}
		// Asking for no interaction is answered, never skipped.
		const silent = await authorize({ ...good, prompt: 'none' });
		expect(outcomeOf(silent.location as string)).toMatchObject({ error: 'consent_required' });
		const ok = await authorize({ ...good, resource: MCP });
		expect(ok.status).toBe(303);
		expect(ok.headers.get('cache-control')).toBe('no-store');
		expect(ok.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
	});

	it('ignores scope words it does not know and never widens what was asked', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const clientId = await publicApp();
		const { challenge } = pkce();
		const opened = await authorize({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: APP_REDIRECT,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			scope: 'familyos.read openid offline_access',
		});
		const id = requestIdOf(opened.location);
		const view = await call('GET', `/api/v1/oauth/requests/${id}`, undefined, cookie);
		expect(view.status).toBe(200);
		expect(view.body).toMatchObject({
			scope: 'read',
			redirectHost: 'app.example',
			loopback: false,
			client: { name: 'Browser helper', kind: 'dynamic', clientHost: null },
		});
		expect(JSON.stringify(view.body)).not.toContain('state');
		const wider = await call(
			'POST',
			`/api/v1/oauth/requests/${id}/approve`,
			{ scope: 'read_write' },
			cookie,
		);
		expect(wider.status).toBe(400);
		const narrow = await call('POST', `/api/v1/oauth/requests/${id}/approve`, {}, cookie);
		expect(narrow.status).toBe(200);
	});

	it('shows a return address on this device as such, matching any port', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const clientId = await publicApp(['http://localhost:7000/cb']);
		const { challenge } = pkce();
		const opened = await authorize({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: 'http://localhost:51234/cb',
			code_challenge: challenge,
			code_challenge_method: 'S256',
		});
		const view = await call(
			'GET',
			`/api/v1/oauth/requests/${requestIdOf(opened.location)}`,
			undefined,
			cookie,
		);
		expect(view.body).toMatchObject({ loopback: true, redirectHost: 'localhost:51234' });
	});

	it('limits how fast one address can open requests', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		let refused = 0;
		for (let i = 0; i < 70; i++)
			if ((await authorize({ client_id: 'x' }, { 'x-forwarded-for': '10.88.0.1' })).status === 429)
				refused++;
		expect(refused).toBeGreaterThan(0);
	});
});

describe('who may decide', () => {
	async function waiting(client?: { id: string; secret: string }) {
		const clientId = client?.id ?? (await publicApp());
		const { challenge } = pkce();
		const opened = await authorize({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: APP_REDIRECT,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state: 'st',
		});
		return requestIdOf(opened.location);
	}
	const grants = () =>
		runtime.handle.db
			.selectFrom('core_api_tokens' as never)
			.selectAll()
			.where('oauth_client_id' as never, 'is not', null as never)
			.execute();

	it('turns the app away on request, once', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const id = await waiting();
		const denied = await call('POST', `/api/v1/oauth/requests/${id}/deny`, undefined, cookie);
		expect(denied.status).toBe(200);
		expect(outcomeOf(denied.body.redirectUrl)).toEqual({
			error: 'access_denied',
			state: 'st',
			iss: BASE,
		});
		expect(new URL(denied.body.redirectUrl).origin).toBe('https://app.example');
		const late = await call('POST', `/api/v1/oauth/requests/${id}/approve`, {}, cookie);
		expect(late.status).toBe(410);
		expect(await grants()).toHaveLength(0);
	});

	it('needs a signed-in person: not a stranger, and not a display', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const id = await waiting();
		for (const path of ['', '/approve', '/deny']) {
			const method = path === '' ? 'GET' : 'POST';
			const res = await call(
				method,
				`/api/v1/oauth/requests/${id}${path}`,
				path === '' ? undefined : {},
			);
			expect(res.status).toBe(401);
		}
		// A paired family display holds only view grants and is nobody.
		const start = await call('POST', '/api/v1/core/displays/pair');
		const confirm = await call(
			'POST',
			'/api/v1/actions/core.confirmDisplayPairing',
			{
				userCode: start.body.userCode,
				name: 'Hall',
				capabilities: ['calendar.view'],
				showNames: false,
			},
			cookie,
		);
		expect(confirm.status).toBe(200);
		const poll = await call('POST', '/api/v1/core/displays/pair/poll', {
			deviceCode: start.body.deviceCode,
		});
		const display = poll.cookie;
		expect(display).toMatch(/^famos_device=/);
		for (const path of ['', '/approve', '/deny']) {
			const method = path === '' ? 'GET' : 'POST';
			const res = await call(
				method,
				`/api/v1/oauth/requests/${id}${path}`,
				path === '' ? undefined : {},
				display,
			);
			expect(res.status).toBe(401);
		}
		expect(await grants()).toHaveLength(0);
	});

	it('refuses a PIN sign-in, which only the password may replace', async () => {
		const { adminId, cookie } = await setupFamily();
		await turnOn(cookie);
		const device = await call('POST', '/api/v1/core/devices/trust', { name: 'Kitchen' }, cookie);
		expect(device.status).toBe(201);
		expect(
			(await call('PUT', `/api/v1/core/members/${adminId}/pin`, { pin: '8642' }, cookie)).status,
		).toBe(200);
		const pin = await call(
			'POST',
			'/api/auth/sign-in/pin',
			{ memberId: adminId, pin: '8642' },
			device.cookie,
		);
		expect(pin.cookie).not.toBe('');
		const id = await waiting();
		const read = await call('GET', `/api/v1/oauth/requests/${id}`, undefined, pin.cookie);
		expect(read.status).toBe(403);
		for (const verb of ['approve', 'deny']) {
			const res = await call('POST', `/api/v1/oauth/requests/${id}/${verb}`, {}, pin.cookie);
			expect(res.status).toBe(403);
		}
		const made = await call('POST', '/api/v1/mcp/oauth-clients', { preset: 'ha' }, pin.cookie);
		expect(made.status).toBe(403);
		expect(await grants()).toHaveLength(0);
	});

	it('lets only the member who set an app up approve it', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		await addMember(cookie, 'Sam');
		const sam = await signInAs('Sam');
		const mine = await registerApp(cookie);
		const id = await waiting({ id: mine.clientId, secret: mine.secret });
		const theirs = await call('GET', `/api/v1/oauth/requests/${id}`, undefined, sam);
		expect(theirs.status).toBe(403);
		const approved = await call('POST', `/api/v1/oauth/requests/${id}/approve`, {}, sam);
		expect(approved.status).toBe(403);
		expect(await grants()).toHaveLength(0);
		// The owner can; the grant is theirs.
		const owner = await call('POST', `/api/v1/oauth/requests/${id}/approve`, {}, cookie);
		expect(owner.status).toBe(200);
		expect(await grants()).toHaveLength(1);
	});

	it('lets a member without the right to connect apps do nothing', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		await addMember(cookie, 'Leo', 'supervised');
		const leo = await signInAs('Leo');
		const id = await waiting();
		expect((await call('GET', `/api/v1/oauth/requests/${id}`, undefined, leo)).status).toBe(403);
		expect((await call('POST', `/api/v1/oauth/requests/${id}/approve`, {}, leo)).status).toBe(403);
	});

	it('lets a request end after ten minutes', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const id = await waiting();
		vi.setSystemTime(Date.now() + 11 * 60 * 1000);
		expect((await call('GET', `/api/v1/oauth/requests/${id}`, undefined, cookie)).status).toBe(410);
		expect((await call('POST', `/api/v1/oauth/requests/${id}/approve`, {}, cookie)).status).toBe(
			410,
		);
	});

	it('records the grant without the code', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const clientId = await publicApp();
		const { challenge } = pkce();
		const back = await connect(cookie, {
			response_type: 'code',
			client_id: clientId,
			redirect_uri: APP_REDIRECT,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state: 'secret-state',
		});
		const rows = await runtime.handle.db
			.selectFrom('core_audit_log' as never)
			.selectAll()
			.execute();
		expect(rows.map((r) => (r as { action_id: string }).action_id)).toContain('core.oauth.grant');
		const text = JSON.stringify(rows);
		expect(text).not.toContain(back.code);
		expect(text).not.toContain('secret-state');
	});
});

describe('the token endpoint', () => {
	async function ready() {
		const { cookie, adminId } = await setupFamily();
		await turnOn(cookie);
		const made = await registerApp(cookie);
		return { cookie, adminId, ...made };
	}
	const exchange = (made: { clientId: string; secret: string }, code: string, more: Params = {}) =>
		token({
			grant_type: 'authorization_code',
			code,
			redirect_uri: APP_REDIRECT,
			client_id: made.clientId,
			client_secret: made.secret,
			...more,
		});
	const begin = async (cookie: string, made: { clientId: string }, resource?: string) => {
		const { verifier, challenge } = pkce();
		const back = await connect(cookie, {
			response_type: 'code',
			client_id: made.clientId,
			redirect_uri: APP_REDIRECT,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			...(resource && { resource }),
		});
		return { verifier, code: back.code };
	};

	it('refuses a wrong verifier, a missing one and a different return address', async () => {
		const { cookie, ...made } = await ready();
		const one = await begin(cookie, made);
		const wrong = await exchange(made, one.code, { code_verifier: pkce().verifier });
		expect(wrong.status).toBe(400);
		expect(wrong.body.error).toBe('invalid_grant');
		// The code was good until now, but a bad try with it must not have burned it silently:
		// the right verifier still works once.
		expect((await exchange(made, one.code, { code_verifier: one.verifier })).status).toBe(200);

		const two = await begin(cookie, made);
		expect((await exchange(made, two.code)).body.error).toBe('invalid_grant');
		const three = await begin(cookie, made);
		const elsewhere = await exchange(made, three.code, {
			code_verifier: three.verifier,
			redirect_uri: 'http://localhost:7000/cb',
		});
		expect(elsewhere.body.error).toBe('invalid_grant');
	});

	it('refuses a code made for another resource, and one that has expired', async () => {
		const { cookie, ...made } = await ready();
		const one = await begin(cookie, made);
		const wrong = await exchange(made, one.code, {
			code_verifier: one.verifier,
			resource: 'https://other.example/mcp',
		});
		expect(wrong.status).toBe(400);
		expect(wrong.body.error).toBe('invalid_target');

		const two = await begin(cookie, made);
		vi.setSystemTime(Date.now() + 61 * 1000);
		const late = await exchange(made, two.code, { code_verifier: two.verifier });
		expect(late.body.error).toBe('invalid_grant');
	});

	it('ends the sign-in when a code is used twice', async () => {
		const { cookie, ...made } = await ready();
		const one = await begin(cookie, made);
		const first = await exchange(made, one.code, { code_verifier: one.verifier });
		expect(first.status).toBe(200);
		expect((await rpc(first.body.access_token)).status).toBe(200);
		const again = await exchange(made, one.code, { code_verifier: one.verifier });
		expect(again.status).toBe(400);
		expect(again.body.error).toBe('invalid_grant');
		expect((await rpc(first.body.access_token)).status).toBe(401);
		const refresh = await token({
			grant_type: 'refresh_token',
			refresh_token: first.body.refresh_token,
			client_id: made.clientId,
			client_secret: made.secret,
		});
		expect(refresh.body.error).toBe('invalid_grant');
	});

	it('hands out the next pair again within the grace, and ends the sign-in on a late replay', async () => {
		const { cookie, ...made } = await ready();
		const one = await begin(cookie, made);
		const first = await exchange(made, one.code, { code_verifier: one.verifier });
		const refresh = (secret: string) =>
			token({
				grant_type: 'refresh_token',
				refresh_token: secret,
				client_id: made.clientId,
				client_secret: made.secret,
			});
		const second = await refresh(first.body.refresh_token);
		expect(second.status).toBe(200);
		// The answer got lost: the same token comes again right away and gets a new pair.
		vi.setSystemTime(Date.now() + 5000);
		const third = await refresh(first.body.refresh_token);
		expect(third.status).toBe(200);
		expect(third.body.refresh_token).not.toBe(second.body.refresh_token);
		expect((await rpc(third.body.access_token)).status).toBe(200);
		// After the grace it is a second holder: the whole sign-in ends.
		vi.setSystemTime(Date.now() + OAUTH_REFRESH_GRACE_MS + 1000);
		const replay = await refresh(first.body.refresh_token);
		expect(replay.status).toBe(400);
		expect(replay.body.error).toBe('invalid_grant');
		expect((await rpc(third.body.access_token)).status).toBe(401);
		expect((await refresh(third.body.refresh_token)).body.error).toBe('invalid_grant');
	});

	it('refuses to widen the scope on refresh, and another app’s refresh token', async () => {
		const { cookie, ...made } = await ready();
		const { verifier, challenge } = pkce();
		const back = await connect(
			cookie,
			{
				response_type: 'code',
				client_id: made.clientId,
				redirect_uri: APP_REDIRECT,
				code_challenge: challenge,
				code_challenge_method: 'S256',
			},
			'read',
		);
		const first = await exchange(made, back.code, { code_verifier: verifier });
		expect(first.body.scope).toBe('familyos.read');
		const wider = await token({
			grant_type: 'refresh_token',
			refresh_token: first.body.refresh_token,
			scope: 'familyos.read familyos.suggest',
			client_id: made.clientId,
			client_secret: made.secret,
		});
		expect(wider.status).toBe(400);
		expect(wider.body.error).toBe('invalid_scope');

		const other = await registerApp(cookie, { name: 'Other', redirectUris: [APP_REDIRECT] });
		const stolen = await token({
			grant_type: 'refresh_token',
			refresh_token: first.body.refresh_token,
			client_id: other.clientId,
			client_secret: other.secret,
		});
		expect(stolen.body.error).toBe('invalid_grant');
	});

	it('answers in the shapes of RFC 6749', async () => {
		const { cookie, ...made } = await ready();
		const basic = await token(
			{ grant_type: 'client_credentials' },
			{ basic: [made.clientId, made.secret] },
		);
		expect(basic.status).toBe(400);
		expect(basic.body.error).toBe('unsupported_grant_type');
		expect(basic.headers.get('cache-control')).toBe('no-store');

		const missing = await token({
			grant_type: 'authorization_code',
			client_id: made.clientId,
			client_secret: made.secret,
		});
		expect(missing.body.error).toBe('invalid_request');

		const json = await token({}, { contentType: 'application/json', body: '{}' });
		expect(json.body.error).toBe('invalid_request');

		const anonymous = await token({ grant_type: 'refresh_token', refresh_token: 'famos_rt_x' });
		expect(anonymous.status).toBe(401);
		expect(anonymous.body.error).toBe('invalid_client');

		const wrongBasic = await token(
			{ grant_type: 'refresh_token', refresh_token: 'famos_rt_x' },
			{ basic: [made.clientId, 'wrong'] },
		);
		expect(wrongBasic.status).toBe(401);
		expect(wrongBasic.headers.get('www-authenticate')).toMatch(/^Basic/);

		const both = await token(
			{ grant_type: 'refresh_token', refresh_token: 'x', client_secret: made.secret },
			{ basic: [made.clientId, made.secret] },
		);
		expect(both.body.error).toBe('invalid_request');

		// A secret an app lost is not accepted from a public client's point of view either.
		const noSecret = await token({
			grant_type: 'refresh_token',
			refresh_token: 'famos_rt_x',
			client_id: made.clientId,
		});
		expect(noSecret.body.error).toBe('invalid_client');
	});

	it('takes at most 16 KB', async () => {
		const { cookie: _cookie, ...made } = await ready();
		const big = await token({
			grant_type: 'refresh_token',
			refresh_token: 'x'.repeat(17 * 1024),
			client_id: made.clientId,
		});
		expect(big.status).toBe(413);
	});

	it('counts wrong secrets and tokens against one budget with /mcp', async () => {
		const { cookie: _cookie, ...made } = await ready();
		const ip = '10.55.0.1';
		const bad = () =>
			token(
				{ grant_type: 'refresh_token', refresh_token: 'famos_rt_x' },
				{ basic: [made.clientId, 'nope'], ip },
			);
		// Thirty are answered as wrong; the thirty-first is turned away.
		for (let i = 0; i < 30; i++) expect((await bad()).status).toBe(401);
		const refused = await bad();
		expect(refused.status).toBe(429);
		expect(refused.headers.get('retry-after')).toBe('60');
		// The same address is refused at /mcp too, though it never tried there.
		expect((await rpc('famos_at_nope', ip)).status).toBe(429);
		// Another address is not.
		expect((await rpc('famos_at_nope', '10.55.0.2')).status).toBe(401);
	});
});

describe('revoking', () => {
	it('ends the sign-in from the app, always answers 200 and leaves other apps’ tokens alone', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const mine = await registerApp(cookie);
		const other = await registerApp(cookie, { name: 'Other', redirectUris: [APP_REDIRECT] });
		const flow = await codeFlow(cookie, mine.secret, mine.clientId);
		const revoke = async (client: { clientId: string; secret: string }, secret: string) => {
			const res = await app.request(`${BASE}/oauth/revoke`, {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'x-forwarded-for': nextIp(),
				},
				body: new URLSearchParams({
					token: secret,
					client_id: client.clientId,
					client_secret: client.secret,
				}).toString(),
			});
			return res.status;
		};
		// Not theirs, unknown, and a wrong secret: the same answer, and nothing happens.
		expect(await revoke(other, flow.refresh)).toBe(200);
		expect(await revoke(mine, 'famos_rt_unknown')).toBe(200);
		expect(await revoke({ clientId: mine.clientId, secret: 'wrong' }, flow.refresh)).toBe(200);
		expect((await rpc(flow.access)).status).toBe(200);
		// An access token is dropped on its own.
		expect(await revoke(mine, flow.access)).toBe(200);
		expect((await rpc(flow.access)).status).toBe(401);
		// The refresh token ends the whole sign-in.
		expect(await revoke(mine, flow.refresh)).toBe(200);
		const refresh = await token({
			grant_type: 'refresh_token',
			refresh_token: flow.refresh,
			client_id: mine.clientId,
			client_secret: mine.secret,
		});
		expect(refresh.body.error).toBe('invalid_grant');
	});
});

describe('the door to /mcp', () => {
	it('carries where to sign in on every 401 while it is on, and the old challenge while off', async () => {
		const { cookie, adminId } = await setupFamily();
		const mcp = await call('POST', '/api/v1/actions/core.setMcpEnabled', { enabled: true }, cookie);
		expect(mcp.body.status).toBe('applied');
		// MCP on, signing in off.
		expect((await rpc(null)).headers.get('www-authenticate')).toBe('Bearer realm="FamilyOS MCP"');
		await turnOn(cookie);
		const challenge = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="familyos.read familyos.suggest"`;
		expect((await rpc(null)).headers.get('www-authenticate')).toBe(challenge);
		const wrong = await rpc('famos_at_nope');
		expect(wrong.status).toBe(401);
		expect(wrong.headers.get('www-authenticate')).toBe(`${challenge}, error="invalid_token"`);
		// A personal key that is unknown is told the same, so a client holding a stale one can find the way.
		const stale = await rpc('famos_stale');
		expect(stale.headers.get('www-authenticate')).toBe(`${challenge}, error="invalid_token"`);
		const key = await runtime.kernel.apiTokens.create(
			{ kind: 'member', memberId: adminId as never, roleId: 'admin' },
			{ name: 'Laptop', scope: 'read' },
		);
		expect((await rpc(key.secret)).status).toBe(200);
	});

	it('ends an access token when its member loses the right or leaves', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const sam = await addMember(cookie, 'Sam');
		const samCookie = await signInAs('Sam');
		const made = await registerApp(samCookie);
		const flow = await codeFlow(samCookie, made.secret, made.clientId);
		expect((await rpc(flow.access)).status).toBe(200);
		const archived = await call(
			'POST',
			'/api/v1/actions/core.archiveMember',
			{ memberId: sam },
			cookie,
		);
		expect(archived.body.status).toBe('applied');
		await vi.waitFor(async () => expect((await rpc(flow.access)).status).toBe(401), {
			timeout: 25_000,
		});
	});

	it('works nowhere but /mcp: not on the app’s API, not on the public API', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const made = await registerApp(cookie);
		const flow = await codeFlow(cookie, made.secret, made.clientId);
		expect((await rpc(flow.access)).status).toBe(200);
		const headers = { authorization: `Bearer ${flow.access}`, 'x-forwarded-for': nextIp() };
		const session = await app.request(`${BASE}/api/v1/core/me`, { headers });
		expect(session.status).toBe(400);
		const other = await app.request(`${BASE}/api/v1/actions/core.setMcpEnabled`, {
			method: 'POST',
			headers: { ...headers, origin: BASE, 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: false }),
		});
		expect([400, 401]).toContain(other.status);
		for (const path of ['/api/public/v1/members', '/api/public/v1/tasks', '/api/public/v1']) {
			const res = await app.request(`${BASE}${path}`, { headers });
			expect(res.status).toBeGreaterThanOrEqual(401);
			expect(res.status).toBeLessThanOrEqual(404);
			expect(res.status).not.toBe(200);
		}
		// MCP is still on: nothing above changed it.
		expect((await rpc(flow.access)).status).toBe(200);
	});

	it('does not accept a client secret or a refresh token as a bearer', async () => {
		const { cookie } = await setupFamily();
		await turnOn(cookie);
		const made = await registerApp(cookie);
		const flow = await codeFlow(cookie, made.secret, made.clientId);
		expect((await rpc(made.secret)).status).toBe(401);
		expect((await rpc(flow.refresh)).status).toBe(401);
	});
});
