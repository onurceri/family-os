import type { Actor, MemberId } from '@famos/sdk';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isOAuthError, type OAuthError, type OAuthStatus } from '../src/oauth.ts';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, type TestKernel } from './harness.ts';

const BASE = 'https://family.example';
const RESOURCE = `${BASE}/mcp`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const REDIRECT = 'https://claude.example/callback';
const HA_REDIRECT = 'https://my.home-assistant.io/redirect/oauth';

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let deniz: Awaited<ReturnType<TestKernel['member']>>;

const tables = () => k.ctx.db.withTables<CoreTables>();

async function boot(options: { publicUrl?: string; on?: boolean } = {}) {
	k = await createTestKernel({ publicUrl: options.publicUrl ?? BASE });
	admin = await k.member('admin');
	deniz = await k.member('member');
	if (options.on !== false) {
		await k.apiTokens.setEnabled(admin.actor, true);
		await k.runner.invoke('core.setMcpOAuth', { oauthEnabled: true }, admin.actor);
	}
}

beforeEach(() => boot());
afterEach(() => k.close());

const b64url = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64url');
async function pkce() {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)).buffer);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: b64url(digest) };
}

/** A client that registered itself (public), as the later registration paths will add them. */
async function publicClient(
	kind: 'dynamic' | 'metadata' = 'dynamic',
	redirectUris = [REDIRECT],
	name = 'Claude',
) {
	const id = `oauth_client_${kind}_${Math.random().toString(36).slice(2)}`;
	await tables()
		.insertInto('core_oauth_clients')
		.values({
			id,
			kind,
			client_id: kind === 'metadata' ? `https://claude.example/${id}.json` : id,
			name,
			redirect_uris: JSON.stringify(redirectUris),
			secret_hash: null,
			require_pkce: 1,
			owner_member_id: null,
			created_at: k.clock.now(),
			last_consented_at: null,
			metadata_fetched_at: null,
			metadata_etag: null,
			revoked_at: null,
		})
		.execute();
	return { id, clientId: kind === 'metadata' ? `https://claude.example/${id}.json` : id };
}

/** Starts a request for a public client and returns what the app keeps. */
async function ask(
	clientId: string,
	extra: Partial<Parameters<TestKernel['oauth']['createRequest']>[0]> = {},
) {
	const p = await pkce();
	const { requestId } = await k.oauth.createRequest({
		clientId,
		redirectUri: REDIRECT,
		state: 'xyz',
		codeChallenge: p.challenge,
		codeChallengeMethod: 'S256',
		resource: RESOURCE,
		...extra,
	});
	return { requestId, verifier: p.verifier };
}

/** The whole way for a public client up to its tokens. */
async function connect(who = deniz, scope = 'familyos.read familyos.suggest') {
	const client = await publicClient();
	const { requestId, verifier } = await ask(client.clientId, { scope });
	const approved = await k.oauth.approve(who.actor, requestId);
	const tokens = await k.oauth.exchangeCode({
		client: { clientId: client.clientId },
		code: approved.code,
		redirectUri: REDIRECT,
		codeVerifier: verifier,
		resource: RESOURCE,
	});
	return { client, tokens, grantId: approved.grantId, requestId, verifier, approved };
}

async function failure(promise: Promise<unknown>): Promise<OAuthError> {
	try {
		await promise;
	} catch (error) {
		if (isOAuthError(error)) return error;
		throw error;
	}
	throw new Error('expected an OAuth error');
}

const code = (e: OAuthError) => e.code;
const asPin = (a: Actor): Actor => ({ ...a, pin: true }) as Actor;

describe('the switches', () => {
	it('start off, and only an admin can change them', async () => {
		await k.close();
		await boot({ on: false });
		expect(await k.oauth.status()).toMatchObject({
			oauthEnabled: false,
			dcrEnabled: false,
			active: false,
		});
		await expect(
			k.runner.invoke('core.setMcpOAuth', { oauthEnabled: true }, deniz.actor),
		).rejects.toMatchObject({ code: 'forbidden' });
		expect((await k.oauth.settings()).oauthEnabled).toBe(false);
	});

	it('are refused without a path-less https address, unless plain http is allowed', async () => {
		for (const [publicUrl, problem] of [
			[undefined, /family address/],
			['https://family.example/famos', /no path/],
			['http://family.example', /allow it for the home network/],
		] as const) {
			await k.close();
			k = await createTestKernel(publicUrl ? { publicUrl } : {});
			admin = await k.member('admin');
			await expect(k.oauth.setSettings(admin.actor, { oauthEnabled: true })).rejects.toThrow(
				problem,
			);
			expect((await k.oauth.settings()).oauthEnabled).toBe(false);
		}
		await k.close();
		k = await createTestKernel({ publicUrl: 'http://192.168.1.5:3000' });
		admin = await k.member('admin');
		await k.apiTokens.setEnabled(admin.actor, true);
		await k.oauth.setSettings(admin.actor, { oauthEnabled: true, allowPlainHttp: true });
		const status = await k.oauth.status();
		expect(status).toMatchObject({
			active: true,
			issuer: 'http://192.168.1.5:3000',
			resource: 'http://192.168.1.5:3000/mcp',
		});
		// Taking the allowance back while it is on is refused: it would leave an address that cannot be used.
		await expect(k.oauth.setSettings(admin.actor, { allowPlainHttp: false })).rejects.toThrow();
		await k.oauth.setSettings(admin.actor, { oauthEnabled: false, allowPlainHttp: false });
		expect(await k.oauth.status()).toMatchObject({ active: false, allowPlainHttp: false });
	});

	it('keep registration behind its own switch, which needs sign-in to be on', async () => {
		await k.close();
		await boot({ on: false });
		await expect(k.oauth.setSettings(admin.actor, { dcrEnabled: true })).rejects.toThrow(
			/Turn on signing in/,
		);
		await k.oauth.setSettings(admin.actor, { oauthEnabled: true, dcrEnabled: true });
		expect(await k.oauth.settings()).toEqual({
			oauthEnabled: true,
			dcrEnabled: true,
			allowPlainHttp: false,
		});
		await k.oauth.setSettings(admin.actor, { oauthEnabled: false });
		expect((await k.oauth.settings()).dcrEnabled).toBe(false);
	});

	it('answer only while the MCP door is on as well', async () => {
		const client = await publicClient();
		await k.apiTokens.setEnabled(admin.actor, false);
		const status: OAuthStatus = await k.oauth.status();
		expect(status.active).toBe(false);
		expect(code(await failure(ask(client.clientId)))).toBe('temporarily_unavailable');
	});
});

describe('an authorization request', () => {
	it('refuses an unknown app and a return address that was not registered, without a redirect', async () => {
		const client = await publicClient();
		const base = {
			redirectUri: REDIRECT,
			codeChallenge: (await pkce()).challenge,
			codeChallengeMethod: 'S256',
		};
		const unknown = await failure(k.oauth.createRequest({ ...base, clientId: 'nobody' }));
		expect([code(unknown), unknown.redirectable]).toEqual(['invalid_request', false]);
		for (const redirectUri of [
			'https://evil.example/callback',
			`${REDIRECT}/`,
			`${REDIRECT}?x=1`,
			'http://claude.example/callback',
			'',
		]) {
			const e = await failure(
				k.oauth.createRequest({ ...base, clientId: client.clientId, redirectUri }),
			);
			expect([code(e), e.redirectable]).toEqual(['invalid_request', false]);
		}
	});

	it('matches a loopback address on everything but the port', async () => {
		const client = await publicClient('dynamic', ['http://127.0.0.1/cb']);
		const ok = await ask(client.clientId, { redirectUri: 'http://127.0.0.1:53124/cb' });
		expect(ok.requestId).toBeTruthy();
		for (const redirectUri of [
			'http://127.0.0.1:53124/other',
			'http://localhost:53124/cb',
			'https://127.0.0.1/cb',
		])
			expect(code(await failure(ask(client.clientId, { redirectUri })))).toBe('invalid_request');
		// Only a loopback registration is relaxed: an https one is matched exactly.
		const https = await publicClient('dynamic', ['https://claude.example:8443/cb']);
		expect(
			code(await failure(ask(https.clientId, { redirectUri: 'https://claude.example:9000/cb' }))),
		).toBe('invalid_request');
	});

	it('wants PKCE with S256 from a public app, and never reads a missing method as plain', async () => {
		const client = await publicClient();
		const { challenge } = await pkce();
		const base = { clientId: client.clientId, redirectUri: REDIRECT, resource: RESOURCE };
		for (const extra of [
			{},
			{ codeChallenge: challenge },
			{ codeChallenge: challenge, codeChallengeMethod: 'plain' },
			{ codeChallenge: challenge, codeChallengeMethod: 's256' },
			{ codeChallenge: 'short', codeChallengeMethod: 'S256' },
		]) {
			const e = await failure(k.oauth.createRequest({ ...base, ...extra }));
			expect([code(e), e.redirectable]).toEqual(['invalid_request', true]);
		}
	});

	it('refuses a resource that is not this family’s MCP address, and a response type other than code', async () => {
		const client = await publicClient();
		for (const resource of ['https://other.example/mcp', `${BASE}/mcp/`, BASE]) {
			const e = await failure(ask(client.clientId, { resource }));
			expect([code(e), e.redirectable]).toEqual(['invalid_target', true]);
		}
		expect(code(await failure(ask(client.clientId, { responseType: 'token' })))).toBe(
			'unsupported_response_type',
		);
		// An app that names no resource (Home Assistant) is served and the request is made for ours.
		const { requestId } = await ask(client.clientId, { resource: undefined });
		const row = await tables()
			.selectFrom('core_oauth_requests')
			.selectAll()
			.where('id', '=', requestId)
			.executeTakeFirstOrThrow();
		expect(row.resource).toBe(RESOURCE);
	});

	it('takes what the app asked for as the most a person may give, ignoring words it does not know', async () => {
		const client = await publicClient();
		const view = async (scope?: string) => {
			const { requestId } = await ask(client.clientId, { scope });
			return (await k.oauth.getRequest(deniz.actor, requestId)).scope;
		};
		expect(await view('familyos.read')).toBe('read');
		expect(await view('openid offline_access familyos.read')).toBe('read');
		expect(await view('familyos.suggest')).toBe('read_write');
		expect(await view('familyos.read familyos.suggest')).toBe('read_write');
		// Nothing it knows asked for: the person may choose, and the default is the narrower sign-in.
		expect(await view('openid profile')).toBe('read_write');
		expect(await view()).toBe('read_write');
	});
});

describe('the person’s decision', () => {
	it('shows who asks and where it goes back to, never the state nor a code', async () => {
		const client = await publicClient('metadata');
		const { requestId } = await ask(client.clientId);
		const view = await k.oauth.getRequest(deniz.actor, requestId);
		expect(view).toMatchObject({
			client: { name: 'Claude', kind: 'metadata', clientHost: 'claude.example' },
			redirectHost: 'claude.example',
			loopback: false,
		});
		expect(JSON.stringify(view)).not.toContain('xyz');
		const local = await publicClient('dynamic', ['http://localhost/cb']);
		const lr = await ask(local.clientId, { redirectUri: 'http://localhost:4000/cb' });
		expect(await k.oauth.getRequest(deniz.actor, lr.requestId)).toMatchObject({
			loopback: true,
			redirectHost: 'localhost:4000',
		});
	});

	it('is for a signed-in person with a password and the right to use AI apps, and no one else', async () => {
		const client = await publicClient();
		const { requestId } = await ask(client.clientId);
		const supervised = await k.member('supervised');
		const refusals: [string, Actor][] = [
			['a PIN sign-in', asPin(deniz.actor)],
			['a supervised member', supervised.actor],
			['the system', { kind: 'system', source: 'test' }],
			[
				'a display',
				{ kind: 'display', deviceId: 'device_1', capabilities: [] } as unknown as Actor,
			],
			['an app', { kind: 'app', appId: 'app_1', roleId: 'member', mode: 'suggest' }],
			[
				'the AI',
				{
					kind: 'ai',
					mode: 'agent',
					source: 'mcp',
					onBehalfOf: deniz.member.id as MemberId,
					roleId: 'member',
				},
			],
			[
				'a member reached through an app',
				{
					...deniz.actor,
					via: { appId: 'app_1', appRoleId: 'member', mode: 'suggest' },
				} as Actor,
			],
		];
		for (const [, actor] of refusals) {
			await expect(k.oauth.getRequest(actor, requestId)).rejects.toThrow();
			await expect(k.oauth.approve(actor, requestId)).rejects.toThrow();
			await expect(k.oauth.deny(actor, requestId)).rejects.toThrow();
		}
		// Nothing was decided by any of those.
		const row = await tables()
			.selectFrom('core_oauth_requests')
			.select('decided_at')
			.where('id', '=', requestId)
			.executeTakeFirstOrThrow();
		expect(row.decided_at).toBeNull();
		const grants = await tables()
			.selectFrom('core_api_tokens')
			.select('id')
			.where('oauth_client_id', 'is not', null)
			.execute();
		expect(grants).toEqual([]);
	});

	it('lets the person narrow the grant but never widen it', async () => {
		const client = await publicClient();
		const read = await ask(client.clientId, { scope: 'familyos.read' });
		await expect(
			k.oauth.approve(deniz.actor, read.requestId, { scope: 'read_write' }),
		).rejects.toThrow(/only to read/);
		const both = await ask(client.clientId, { scope: 'familyos.read familyos.suggest' });
		const done = await k.oauth.approve(deniz.actor, both.requestId, { scope: 'read' });
		const grant = await tables()
			.selectFrom('core_api_tokens')
			.select('scope')
			.where('id', '=', done.grantId)
			.executeTakeFirstOrThrow();
		expect(grant.scope).toBe('read');
	});

	it('can be made once; an answered or expired request is gone', async () => {
		const client = await publicClient();
		const first = await ask(client.clientId);
		await k.oauth.approve(deniz.actor, first.requestId);
		await expect(k.oauth.approve(deniz.actor, first.requestId)).rejects.toMatchObject({
			code: 'gone',
		});
		await expect(k.oauth.getRequest(deniz.actor, first.requestId)).rejects.toMatchObject({
			code: 'gone',
		});
		const second = await ask(client.clientId);
		const back = await k.oauth.deny(deniz.actor, second.requestId);
		expect(back).toEqual({ redirectUri: REDIRECT, state: 'xyz' });
		await expect(k.oauth.approve(deniz.actor, second.requestId)).rejects.toMatchObject({
			code: 'gone',
		});
		const third = await ask(client.clientId);
		k.clock.advance(10 * 60 * 1000 + 1);
		await expect(k.oauth.approve(deniz.actor, third.requestId)).rejects.toMatchObject({
			code: 'gone',
		});
		await expect(k.oauth.deny(deniz.actor, third.requestId)).rejects.toMatchObject({
			code: 'gone',
		});
		await expect(k.oauth.getRequest(deniz.actor, 'not-a-request')).rejects.toMatchObject({
			code: 'gone',
		});
	});

	it('makes a grant for the person who is signed in, and tells them', async () => {
		const { grantId } = await connect();
		const grant = await tables()
			.selectFrom('core_api_tokens')
			.selectAll()
			.where('id', '=', grantId)
			.executeTakeFirstOrThrow();
		expect(grant).toMatchObject({
			member_id: deniz.member.id,
			name: 'Claude',
			scope: 'read_write',
			token_hash: `oauth:${grantId}`,
			expires_at: k.clock.now() + 90 * DAY,
			revoked_at: null,
		});
		expect(grant.oauth_client_id).not.toBeNull();
		const audit = await tables()
			.selectFrom('core_audit_log')
			.select(['action_id', 'target'])
			.where('action_id', '=', 'core.oauth.grant')
			.execute();
		expect(audit).toEqual([{ action_id: 'core.oauth.grant', target: grantId }]);
		await k.worker.drain();
		const notes = await tables()
			.selectFrom('core_notifications')
			.select(['member_id', 'kind', 'title_key', 'url'])
			.execute();
		expect(notes).toEqual([
			{
				member_id: deniz.member.id,
				kind: 'core.aiAppConnected',
				title_key: 'app:notify_ai_app_connected_title',
				url: '/settings/connected-apps',
			},
		]);
		// The grant shows among the member's keys and not among anyone else's.
		const listed = await k.apiTokens.list(deniz.actor);
		expect(listed.map((t) => [t.id, t.oauthClientId !== null])).toEqual([[grantId, true]]);
		expect(await k.apiTokens.list(admin.actor)).toEqual([]);
	});

	it('replaces the person’s earlier grant to the same app and forgets what it was shown', async () => {
		const client = await publicClient();
		const connectAgain = async () => {
			const { requestId, verifier } = await ask(client.clientId);
			const approved = await k.oauth.approve(deniz.actor, requestId);
			const tokens = await k.oauth.exchangeCode({
				client: { clientId: client.clientId },
				code: approved.code,
				redirectUri: REDIRECT,
				codeVerifier: verifier,
			});
			return { grantId: approved.grantId, tokens };
		};
		const first = await connectAgain();
		await k.apiTokens.rememberHandles(first.grantId, [{ handle: 'event:aa', id: 'event_1' }]);
		const second = await connectAgain();
		expect(await k.apiTokens.authenticate(first.tokens.accessToken)).toBeNull();
		expect(await k.apiTokens.authenticate(second.tokens.accessToken)).not.toBeNull();
		expect((await k.apiTokens.resolveHandles(first.grantId, ['event:aa'])).size).toBe(0);
		const leftover = await tables()
			.selectFrom('core_oauth_tokens')
			.select('id')
			.where('grant_id', '=', first.grantId)
			.execute();
		expect(leftover).toEqual([]);
		// Another person connecting the same app does not touch the first person's grant.
		const other = await k.member('member');
		const { requestId } = await ask(client.clientId);
		await k.oauth.approve(other.actor, requestId);
		expect(await k.apiTokens.authenticate(second.tokens.accessToken)).not.toBeNull();
	});

	it('stops at twenty keys for a person', async () => {
		for (let i = 0; i < 20; i++)
			await k.apiTokens.create(deniz.actor, { name: `Key ${i}`, scope: 'read' });
		const client = await publicClient();
		const { requestId } = await ask(client.clientId);
		await expect(k.oauth.approve(deniz.actor, requestId)).rejects.toMatchObject({
			code: 'limit_reached',
		});
		const row = await tables()
			.selectFrom('core_oauth_requests')
			.select('decided_at')
			.where('id', '=', requestId)
			.executeTakeFirstOrThrow();
		expect(row.decided_at).toBeNull();
	});
});

describe('trading a code for tokens', () => {
	it('gives an access token that works as the person’s AI agent, and a refresh token', async () => {
		const { tokens, grantId } = await connect();
		expect(tokens).toMatchObject({
			tokenType: 'Bearer',
			expiresIn: 3600,
			scope: 'familyos.read familyos.suggest',
		});
		expect(tokens.accessToken.startsWith('famos_at_')).toBe(true);
		expect(tokens.refreshToken.startsWith('famos_rt_')).toBe(true);
		const caller = await k.apiTokens.authenticate(tokens.accessToken);
		expect(caller).toMatchObject({
			token: { id: grantId, memberId: deniz.member.id, scope: 'read_write', name: 'Claude' },
			member: { id: deniz.member.id, roleId: 'member' },
		});
		// A personal key gives the same shape.
		const { secret } = await k.apiTokens.create(deniz.actor, { name: 'Laptop', scope: 'read' });
		const personal = await k.apiTokens.authenticate(secret);
		expect(Object.keys(personal ?? {}).sort()).toEqual(Object.keys(caller ?? {}).sort());
		expect(Object.keys(personal?.token ?? {}).sort()).toEqual(
			Object.keys(caller?.token ?? {}).sort(),
		);
		// A refresh token is not a bearer for the door.
		expect(await k.apiTokens.authenticate(tokens.refreshToken)).toBeNull();
	});

	it('grants only read when that was chosen', async () => {
		const { tokens, grantId } = await connect(deniz, 'familyos.read');
		expect(tokens.scope).toBe('familyos.read');
		expect((await k.apiTokens.authenticate(tokens.accessToken))?.token).toMatchObject({
			id: grantId,
			scope: 'read',
		});
	});

	it('checks the verifier, the return address, the app and the resource', async () => {
		const client = await publicClient();
		const attempt = async (
			mutate: (
				o: Parameters<TestKernel['oauth']['exchangeCode']>[0],
			) => Parameters<TestKernel['oauth']['exchangeCode']>[0],
		) => {
			const { requestId, verifier } = await ask(client.clientId);
			const approved = await k.oauth.approve(deniz.actor, requestId);
			return {
				approved,
				call: () =>
					k.oauth.exchangeCode(
						mutate({
							client: { clientId: client.clientId },
							code: approved.code,
							redirectUri: REDIRECT,
							codeVerifier: verifier,
							resource: RESOURCE,
						}),
					),
			};
		};
		const cases: [string, Parameters<typeof attempt>[0], string][] = [
			['a wrong verifier', (o) => ({ ...o, codeVerifier: 'a'.repeat(50) }), 'invalid_grant'],
			['no verifier', (o) => ({ ...o, codeVerifier: undefined }), 'invalid_grant'],
			['a short verifier', (o) => ({ ...o, codeVerifier: 'short' }), 'invalid_grant'],
			[
				'another return address',
				(o) => ({ ...o, redirectUri: 'https://claude.example/other' }),
				'invalid_grant',
			],
			['another app', (o) => ({ ...o, client: { clientId: 'someone-else' } }), 'invalid_client'],
			[
				'another resource',
				(o) => ({ ...o, resource: 'https://other.example/mcp' }),
				'invalid_target',
			],
			['a made up code', (o) => ({ ...o, code: 'nope' }), 'invalid_grant'],
		];
		for (const [, mutate, expected] of cases) {
			const { call } = await attempt(mutate);
			expect(code(await failure(call()))).toBe(expected);
		}
		// A refused try does not use the code up: the right app, with the right proof, still gets it.
		const { call } = await attempt((o) => o);
		expect((await call()).accessToken).toBeTruthy();
	});

	it('refuses a code made for another app', async () => {
		const mine = await publicClient();
		const theirs = await publicClient('dynamic', [REDIRECT], 'Other');
		const { requestId, verifier } = await ask(mine.clientId);
		const approved = await k.oauth.approve(deniz.actor, requestId);
		const e = await failure(
			k.oauth.exchangeCode({
				client: { clientId: theirs.clientId },
				code: approved.code,
				redirectUri: REDIRECT,
				codeVerifier: verifier,
			}),
		);
		expect(code(e)).toBe('invalid_grant');
	});

	it('lives sixty seconds', async () => {
		const client = await publicClient();
		const { requestId, verifier } = await ask(client.clientId);
		const approved = await k.oauth.approve(deniz.actor, requestId);
		k.clock.advance(61_000);
		const e = await failure(
			k.oauth.exchangeCode({
				client: { clientId: client.clientId },
				code: approved.code,
				redirectUri: REDIRECT,
				codeVerifier: verifier,
			}),
		);
		expect(code(e)).toBe('invalid_grant');
	});

	it('ends the grant when a code is used twice', async () => {
		const client = await publicClient();
		const { requestId, verifier } = await ask(client.clientId);
		const approved = await k.oauth.approve(deniz.actor, requestId);
		const trade = () =>
			k.oauth.exchangeCode({
				client: { clientId: client.clientId },
				code: approved.code,
				redirectUri: REDIRECT,
				codeVerifier: verifier,
			});
		const tokens = await trade();
		expect(await k.apiTokens.authenticate(tokens.accessToken)).not.toBeNull();
		expect(code(await failure(trade()))).toBe('invalid_grant');
		// What the first trade got stopped working with it.
		expect(await k.apiTokens.authenticate(tokens.accessToken)).toBeNull();
		const grant = await tables()
			.selectFrom('core_api_tokens')
			.select('revoked_at')
			.where('id', '=', approved.grantId)
			.executeTakeFirstOrThrow();
		expect(grant.revoked_at).not.toBeNull();
		expect(
			code(
				await failure(
					k.oauth.refresh({
						client: { clientId: client.clientId },
						refreshToken: tokens.refreshToken,
					}),
				),
			),
		).toBe('invalid_grant');
	});

	it('stores no code, token or secret in clear', async () => {
		const { tokens, approved, verifier } = await connect();
		const { clientSecret } = await k.oauth.createClient(deniz.actor, {
			name: 'HA',
			redirectUris: [HA_REDIRECT],
			requirePkce: false,
		});
		const dump: string[] = [];
		for (const table of [
			'core_oauth_clients',
			'core_oauth_requests',
			'core_oauth_codes',
			'core_oauth_tokens',
			'core_api_tokens',
			'core_audit_log',
			'core_notifications',
			'core_settings',
		] as const) {
			const rows = await sql<unknown>`select * from ${sql.table(table)}`.execute(k.ctx.db);
			dump.push(JSON.stringify(rows.rows));
		}
		for (const secret of [tokens.accessToken, tokens.refreshToken, approved.code, clientSecret])
			expect(dump.join('\n')).not.toContain(secret.slice(10));
		// The verifier never reaches the server except to be checked.
		expect(dump.join('\n')).not.toContain(verifier);
	});
});

describe('a registered app with a secret (Home Assistant)', () => {
	async function homeAssistant(who = deniz) {
		const made = await k.oauth.createClient(who.actor, {
			name: 'Home Assistant',
			redirectUris: [HA_REDIRECT, 'https://ha.example/auth/external/callback'],
			requirePkce: false,
		});
		return made;
	}

	it('trades a code with its secret and without PKCE', async () => {
		const { client, clientSecret } = await homeAssistant();
		expect(client).toMatchObject({
			kind: 'registered',
			requirePkce: false,
			ownerMemberId: deniz.member.id,
		});
		expect(clientSecret.startsWith('famos_cs_')).toBe(true);
		expect(client.clientId).toBe(client.id);
		const { requestId } = await k.oauth.createRequest({
			clientId: client.clientId,
			redirectUri: HA_REDIRECT,
			state: 's',
		});
		const approved = await k.oauth.approve(deniz.actor, requestId);
		const tokens = await k.oauth.exchangeCode({
			client: { clientId: client.clientId, clientSecret },
			code: approved.code,
			redirectUri: HA_REDIRECT,
		});
		expect(await k.apiTokens.authenticate(tokens.accessToken)).toMatchObject({
			token: { name: 'Home Assistant', memberId: deniz.member.id },
		});
	});

	it('refuses a missing or wrong secret, at every endpoint that takes the app’s own proof', async () => {
		const { client, clientSecret } = await homeAssistant();
		const { requestId } = await k.oauth.createRequest({
			clientId: client.clientId,
			redirectUri: HA_REDIRECT,
		});
		const approved = await k.oauth.approve(deniz.actor, requestId);
		for (const secret of [
			undefined,
			'',
			'famos_cs_wrong',
			`${clientSecret}x`,
			clientSecret.slice(0, -1),
		]) {
			const e = await failure(
				k.oauth.exchangeCode({
					client: { clientId: client.clientId, clientSecret: secret },
					code: approved.code,
					redirectUri: HA_REDIRECT,
				}),
			);
			expect(code(e)).toBe('invalid_client');
		}
		const tokens = await k.oauth.exchangeCode({
			client: { clientId: client.clientId, clientSecret },
			code: approved.code,
			redirectUri: HA_REDIRECT,
		});
		expect(
			code(
				await failure(
					k.oauth.refresh({
						client: { clientId: client.clientId },
						refreshToken: tokens.refreshToken,
					}),
				),
			),
		).toBe('invalid_client');
		expect(
			code(
				await failure(
					k.oauth.revokeToken({
						client: { clientId: client.clientId, clientSecret: 'x' },
						token: tokens.refreshToken,
					}),
				),
			),
		).toBe('invalid_client');
		expect(await k.apiTokens.authenticate(tokens.accessToken)).not.toBeNull();
	});

	it('does not take a secret from an app that has none, and when PKCE is required it is enforced', async () => {
		const pub = await publicClient();
		const { requestId, verifier } = await ask(pub.clientId);
		const approved = await k.oauth.approve(deniz.actor, requestId);
		const e = await failure(
			k.oauth.exchangeCode({
				client: { clientId: pub.clientId, clientSecret: 'famos_cs_guess' },
				code: approved.code,
				redirectUri: REDIRECT,
				codeVerifier: verifier,
			}),
		);
		expect(code(e)).toBe('invalid_client');
		const { client } = await k.oauth.createClient(deniz.actor, {
			name: 'Strict',
			redirectUris: [REDIRECT],
		});
		expect(client.requirePkce).toBe(true);
		const missing = await failure(
			k.oauth.createRequest({ clientId: client.clientId, redirectUri: REDIRECT }),
		);
		expect([code(missing), missing.redirectable]).toEqual(['invalid_request', true]);
	});

	it('can be approved only by the member who set it up', async () => {
		const { client } = await homeAssistant();
		const { requestId } = await k.oauth.createRequest({
			clientId: client.clientId,
			redirectUri: HA_REDIRECT,
		});
		for (const other of [await k.member('member'), admin]) {
			await expect(k.oauth.getRequest(other.actor, requestId)).rejects.toThrow(/someone else/);
			await expect(k.oauth.approve(other.actor, requestId)).rejects.toThrow(/someone else/);
			await expect(k.oauth.deny(other.actor, requestId)).rejects.toThrow(/someone else/);
		}
		await k.oauth.approve(deniz.actor, requestId);
	});

	it('skips PKCE only when it is a registered app: the database refuses it for any other', async () => {
		await expect(
			sql`insert into core_oauth_clients (id, kind, client_id, name, redirect_uris, require_pkce, created_at)
				values ('c1', 'dynamic', 'c1', 'X', '[]', 0, 1)`.execute(k.ctx.db),
		).rejects.toThrow(/CHECK/);
		await expect(
			sql`insert into core_oauth_clients (id, kind, client_id, name, redirect_uris, require_pkce, created_at)
				values ('c2', 'metadata', 'https://x.example/c.json', 'X', '[]', 0, 1)`.execute(k.ctx.db),
		).rejects.toThrow(/CHECK/);
	});
});

describe('refreshing', () => {
	const refresh = (clientId: string, refreshToken: string) =>
		k.oauth.refresh({ client: { clientId }, refreshToken });

	it('rotates: every use gives a new pair, and the access token already out lives on', async () => {
		const { client, tokens } = await connect();
		k.clock.advance(10 * 60 * 1000);
		const next = await refresh(client.clientId, tokens.refreshToken);
		expect(next.accessToken).not.toBe(tokens.accessToken);
		expect(next.refreshToken).not.toBe(tokens.refreshToken);
		expect(next.scope).toBe(tokens.scope);
		expect(await k.apiTokens.authenticate(tokens.accessToken)).not.toBeNull();
		expect(await k.apiTokens.authenticate(next.accessToken)).not.toBeNull();
		const third = await refresh(client.clientId, next.refreshToken);
		expect(third.refreshToken).not.toBe(next.refreshToken);
	});

	it('lets an access token last an hour; a refresh token gets a new one', async () => {
		const { client, tokens } = await connect();
		k.clock.advance(HOUR - 1);
		expect(await k.apiTokens.authenticate(tokens.accessToken)).not.toBeNull();
		k.clock.advance(2);
		expect(await k.apiTokens.authenticate(tokens.accessToken)).toBeNull();
		const next = await refresh(client.clientId, tokens.refreshToken);
		expect(await k.apiTokens.authenticate(next.accessToken)).not.toBeNull();
	});

	it('gives a new pair to a retry within thirty seconds, and then the lost pair is dead', async () => {
		const { client, tokens } = await connect();
		const lost = await refresh(client.clientId, tokens.refreshToken);
		k.clock.advance(20_000);
		const retry = await refresh(client.clientId, tokens.refreshToken);
		expect(retry.refreshToken).not.toBe(lost.refreshToken);
		expect(await k.apiTokens.authenticate(retry.accessToken)).not.toBeNull();
		// The pair the app never saw is not left lying around.
		expect(await k.apiTokens.authenticate(lost.accessToken)).toBeNull();
		expect(code(await failure(refresh(client.clientId, lost.refreshToken)))).toBe('invalid_grant');
		// The grant still lives and the retry's pair goes on.
		const next = await refresh(client.clientId, retry.refreshToken);
		expect(await k.apiTokens.authenticate(next.accessToken)).not.toBeNull();
	});

	it('ends the grant, writes the audit row and tells the person when an old token comes back', async () => {
		const { client, tokens, grantId } = await connect();
		const next = await refresh(client.clientId, tokens.refreshToken);
		k.clock.advance(31_000);
		expect(code(await failure(refresh(client.clientId, tokens.refreshToken)))).toBe(
			'invalid_grant',
		);
		// Everything the app held is dead, the new pair too.
		expect(await k.apiTokens.authenticate(next.accessToken)).toBeNull();
		expect(code(await failure(refresh(client.clientId, next.refreshToken)))).toBe('invalid_grant');
		const grant = await tables()
			.selectFrom('core_api_tokens')
			.select('revoked_at')
			.where('id', '=', grantId)
			.executeTakeFirstOrThrow();
		expect(grant.revoked_at).not.toBeNull();
		const audit = await tables()
			.selectFrom('core_audit_log')
			.select(['action_id', 'target', 'outcome'])
			.where('action_id', '=', 'core.oauth.replay')
			.execute();
		expect(audit).toEqual([
			{ action_id: 'core.oauth.replay', target: grantId, outcome: 'applied' },
		]);
		await k.worker.drain();
		const notes = await tables()
			.selectFrom('core_notifications')
			.select(['member_id', 'kind'])
			.where('kind', '=', 'core.aiAppDisconnected')
			.execute();
		expect(notes).toEqual([{ member_id: deniz.member.id, kind: 'core.aiAppDisconnected' }]);
	});

	it('treats a token used while its successor was used as a second holder', async () => {
		const { client, tokens } = await connect();
		const next = await refresh(client.clientId, tokens.refreshToken);
		await refresh(client.clientId, next.refreshToken);
		// Within the grace, but the successor has been used: someone else holds the first token.
		expect(code(await failure(refresh(client.clientId, tokens.refreshToken)))).toBe(
			'invalid_grant',
		);
		const revoked = await tables()
			.selectFrom('core_api_tokens')
			.select('revoked_at')
			.where('oauth_client_id', 'is not', null)
			.executeTakeFirstOrThrow();
		expect(revoked.revoked_at).not.toBeNull();
	});

	it('refuses another app’s refresh token without ending anything', async () => {
		const { tokens, grantId } = await connect();
		const other = await publicClient('dynamic', [REDIRECT], 'Other');
		expect(code(await failure(refresh(other.clientId, tokens.refreshToken)))).toBe('invalid_grant');
		const grant = await tables()
			.selectFrom('core_api_tokens')
			.select('revoked_at')
			.where('id', '=', grantId)
			.executeTakeFirstOrThrow();
		expect(grant.revoked_at).toBeNull();
		expect(code(await failure(refresh('nobody', tokens.refreshToken)))).toBe('invalid_client');
		expect(code(await failure(refresh(other.clientId, 'famos_at_nope')))).toBe('invalid_grant');
	});

	it('keeps a grant for ninety days after it was last used, not ninety days in all', async () => {
		const { client, tokens, grantId } = await connect();
		let current = tokens;
		for (let i = 0; i < 4; i++) {
			k.clock.advance(80 * DAY);
			current = await refresh(client.clientId, current.refreshToken);
			expect(await k.apiTokens.authenticate(current.accessToken)).not.toBeNull();
		}
		// 320 days in, still connected, and the end moved with each use.
		const grant = await tables()
			.selectFrom('core_api_tokens')
			.select('expires_at')
			.where('id', '=', grantId)
			.executeTakeFirstOrThrow();
		expect(grant.expires_at).toBe(k.clock.now() + 90 * DAY);
		k.clock.advance(90 * DAY + 1);
		expect(await k.apiTokens.authenticate(current.accessToken)).toBeNull();
		expect(code(await failure(refresh(client.clientId, current.refreshToken)))).toBe(
			'invalid_grant',
		);
	});

	it('may ask for less than was granted but not more', async () => {
		const { client, tokens } = await connect(deniz, 'familyos.read');
		const more = await failure(
			k.oauth.refresh({
				client: { clientId: client.clientId },
				refreshToken: tokens.refreshToken,
				scope: 'familyos.suggest',
			}),
		);
		expect(code(more)).toBe('invalid_scope');
		const same = await k.oauth.refresh({
			client: { clientId: client.clientId },
			refreshToken: tokens.refreshToken,
			scope: 'familyos.read',
		});
		expect(same.scope).toBe('familyos.read');
	});
});

describe('revoking from the app', () => {
	it('ends the grant when it is the refresh token, and only that token when it is the access token', async () => {
		const { client, tokens } = await connect();
		await k.oauth.revokeToken({ client: { clientId: client.clientId }, token: tokens.accessToken });
		expect(await k.apiTokens.authenticate(tokens.accessToken)).toBeNull();
		const again = await k.oauth.refresh({
			client: { clientId: client.clientId },
			refreshToken: tokens.refreshToken,
		});
		expect(await k.apiTokens.authenticate(again.accessToken)).not.toBeNull();
		await k.oauth.revokeToken({ client: { clientId: client.clientId }, token: again.refreshToken });
		expect(await k.apiTokens.authenticate(again.accessToken)).toBeNull();
		expect(
			code(
				await failure(
					k.oauth.refresh({
						client: { clientId: client.clientId },
						refreshToken: again.refreshToken,
					}),
				),
			),
		).toBe('invalid_grant');
	});

	it('says nothing about tokens it does not know or that belong to another app', async () => {
		const { client, tokens } = await connect();
		const other = await publicClient('dynamic', [REDIRECT], 'Other');
		await k.oauth.revokeToken({ client: { clientId: other.clientId }, token: tokens.refreshToken });
		await k.oauth.revokeToken({ client: { clientId: client.clientId }, token: 'famos_rt_unknown' });
		await k.oauth.revokeToken({ client: { clientId: client.clientId }, token: '' });
		expect(await k.apiTokens.authenticate(tokens.accessToken)).not.toBeNull();
	});
});

describe('the bearer lookup', () => {
	it('refuses what is not an access token it issued', async () => {
		for (const secret of [
			'famos_at_',
			'famos_at_unknown',
			`famos_at_${'a'.repeat(200)}`,
			'famos_rt_x',
			'famos_cs_x',
			'Bearer',
		])
			expect(await k.apiTokens.authenticate(secret)).toBeNull();
		// A grant row can never be found as a personal key: its hash is not a digest.
		const { grantId } = await connect();
		expect(await k.apiTokens.authenticate(`oauth:${grantId}`)).toBeNull();
	});

	it('stops when sign-in for AI apps is turned off, and works again when it is turned back on', async () => {
		const { tokens } = await connect();
		await k.oauth.setSettings(admin.actor, { oauthEnabled: false });
		expect(await k.apiTokens.authenticate(tokens.accessToken)).toBeNull();
		await k.oauth.setSettings(admin.actor, { oauthEnabled: true });
		expect(await k.apiTokens.authenticate(tokens.accessToken)).not.toBeNull();
	});

	it('refuses a token made for another address', async () => {
		const { tokens } = await connect();
		await tables()
			.updateTable('core_oauth_tokens')
			.set({ resource: 'https://old.example/mcp' })
			.execute();
		expect(await k.apiTokens.authenticate(tokens.accessToken)).toBeNull();
	});

	it('does not count a refused try as a use', async () => {
		const { tokens, grantId } = await connect();
		await k.oauth.setSettings(admin.actor, { oauthEnabled: false });
		await k.apiTokens.authenticate(tokens.accessToken);
		const grant = await tables()
			.selectFrom('core_api_tokens')
			.select('last_used_at')
			.where('id', '=', grantId)
			.executeTakeFirstOrThrow();
		expect(grant.last_used_at).toBeNull();
		await k.oauth.setSettings(admin.actor, { oauthEnabled: true });
		await k.apiTokens.touch(grantId);
		const used = await tables()
			.selectFrom('core_api_tokens')
			.select('last_used_at')
			.where('id', '=', grantId)
			.executeTakeFirstOrThrow();
		expect(used.last_used_at).toBe(k.clock.now());
	});

	it('personal keys never start like the secrets an app holds', async () => {
		for (let i = 0; i < 40; i++) {
			const { secret } = await k.apiTokens.create(admin.actor, { name: `k${i}`, scope: 'read' });
			expect(/^famos_(at|rt|cs)_/.test(secret)).toBe(false);
			await k.apiTokens.revoke(admin.actor, (await k.apiTokens.list(admin.actor))[0]?.id ?? '');
		}
	});
});

describe('what ends a grant at once', () => {
	const live = async (tokens: { accessToken: string }) =>
		(await k.apiTokens.authenticate(tokens.accessToken)) !== null;

	it('revoking it, as the owner or an admin, but not as someone else', async () => {
		const a = await connect();
		const stranger = await k.member('member');
		await expect(
			k.runner.invoke('core.revokeApiToken', { tokenId: a.grantId }, stranger.actor),
		).rejects.toMatchObject({ code: 'not_found' });
		expect(await live(a.tokens)).toBe(true);
		await k.runner.invoke('core.revokeApiToken', { tokenId: a.grantId }, deniz.actor);
		expect(await live(a.tokens)).toBe(false);
		expect(
			code(
				await failure(
					k.oauth.refresh({
						client: { clientId: a.client.clientId },
						refreshToken: a.tokens.refreshToken,
					}),
				),
			),
		).toBe('invalid_grant');

		const b = await connect();
		await k.runner.invoke('core.revokeApiToken', { tokenId: b.grantId }, admin.actor);
		expect(await live(b.tokens)).toBe(false);
	});

	it('signing out everywhere, a new password and archiving', async () => {
		const out = await connect();
		await k.route('core.signOutEverywhere').call({ actor: deniz.actor });
		expect(await live(out.tokens)).toBe(false);

		const pw = await k.member('member');
		const viaPw = await connect(pw);
		await k.route('core.setMemberPassword').call({
			actor: admin.actor,
			params: { memberId: pw.member.id },
			body: { email: 'pw@example.com', password: 'a long enough password' },
		});
		expect(await live(viaPw.tokens)).toBe(false);
		expect(
			code(
				await failure(
					k.oauth.refresh({
						client: { clientId: viaPw.client.clientId },
						refreshToken: viaPw.tokens.refreshToken,
					}),
				),
			),
		).toBe('invalid_grant');

		const gone = await k.member('member');
		const viaArchive = await connect(gone);
		await k.runner.invoke('core.archiveMember', { memberId: gone.member.id }, admin.actor);
		expect(await live(viaArchive.tokens)).toBe(false);
	});

	it('a role that loses the right to use AI apps', async () => {
		const { tokens } = await connect();
		const caller = await k.apiTokens.authenticate(tokens.accessToken);
		const holder = (): Actor => ({
			kind: 'member',
			memberId: (caller?.member.id ?? '') as MemberId,
			roleId: caller?.member.roleId ?? 'member',
		});
		expect(k.access.can(holder(), 'core.mcp.use')).toBe(true);
		await k.runner.invoke(
			'core.updateMember',
			{ memberId: deniz.member.id, roleId: 'supervised' },
			admin.actor,
		);
		// The lookup still names the member, with today's role; the door asks the role each time.
		const again = await k.apiTokens.authenticate(tokens.accessToken);
		expect(again?.member.roleId).toBe('supervised');
		expect(
			k.access.can(
				{ kind: 'member', memberId: deniz.member.id as MemberId, roleId: 'supervised' },
				'core.mcp.use',
			),
		).toBe(false);
	});
});

describe('apps set up by a member', () => {
	it('are for a person with a password and the right to use AI apps', async () => {
		const input = { name: 'Home Assistant', redirectUris: [HA_REDIRECT], requirePkce: false };
		await expect(k.oauth.createClient(asPin(deniz.actor), input)).rejects.toThrow();
		await expect(
			k.oauth.createClient((await k.member('supervised')).actor, input),
		).rejects.toThrow();
		await expect(
			k.oauth.createClient({ kind: 'app', appId: 'a', roleId: 'member', mode: 'apply' }, input),
		).rejects.toThrow();
		await expect(k.oauth.createClient(deniz.actor, { ...input, name: '  ' })).rejects.toThrow(
			/name/,
		);
	});

	it('take only https return addresses, or loopback, and few of them', async () => {
		const make = (redirectUris: string[]) =>
			k.oauth.createClient(deniz.actor, { name: 'X', redirectUris });
		await expect(make([])).rejects.toThrow();
		await expect(make(['not a url'])).rejects.toThrow();
		await expect(make(['http://ha.local:8123/auth/external/callback'])).rejects.toThrow(/https/);
		await expect(make(['https://x.example/cb#frag'])).rejects.toThrow(/fragment/);
		await expect(make(['https://user:pw@x.example/cb'])).rejects.toThrow(/login/);
		await expect(make(['javascript:alert(1)'])).rejects.toThrow();
		await expect(
			make(Array.from({ length: 6 }, (_, i) => `https://x.example/${i}`)),
		).rejects.toThrow();
		await expect(make(['http://127.0.0.1/cb'])).resolves.toBeTruthy();
		// A home network on plain http is the admin's choice.
		await k.oauth.setSettings(admin.actor, { allowPlainHttp: true });
		await expect(make(['http://ha.local:8123/auth/external/callback'])).resolves.toBeTruthy();
	});

	it('are limited to ten per person', async () => {
		for (let i = 0; i < 10; i++)
			await k.oauth.createClient(deniz.actor, { name: `App ${i}`, redirectUris: [REDIRECT] });
		await expect(
			k.oauth.createClient(deniz.actor, { name: 'One more', redirectUris: [REDIRECT] }),
		).rejects.toMatchObject({ code: 'limit_reached' });
		await k.oauth.createClient(admin.actor, { name: 'Another person’s', redirectUris: [REDIRECT] });
	});

	it('are listed for their owner, and for everyone to an admin, without a secret', async () => {
		const mine = await k.oauth.createClient(deniz.actor, {
			name: 'Mine',
			redirectUris: [REDIRECT],
		});
		await k.oauth.createClient(admin.actor, { name: 'Theirs', redirectUris: [REDIRECT] });
		const listed = await k.oauth.listClients(deniz.actor);
		expect(listed.map((c) => c.name)).toEqual(['Mine']);
		expect(JSON.stringify(listed)).not.toContain('secret');
		expect(JSON.stringify(listed)).not.toContain(mine.clientSecret);
		expect(
			(await k.oauth.listClients(admin.actor, { all: true })).map((c) => c.name).sort(),
		).toEqual(['Mine', 'Theirs']);
		await expect(k.oauth.listClients(deniz.actor, { all: true })).rejects.toMatchObject({
			code: 'forbidden',
		});
		const audit = await tables()
			.selectFrom('core_audit_log')
			.select(['action_id', 'target'])
			.where('action_id', '=', 'core.oauth.registerClient')
			.execute();
		expect(audit.map((a) => a.target)).toContain(mine.client.id);
		// The audit row names the app, never its secret.
		expect(JSON.stringify(audit)).not.toContain(mine.clientSecret);
	});

	it('are removed by their owner or an admin, with every sign-in they hold', async () => {
		const made = await k.oauth.createClient(deniz.actor, {
			name: 'HA',
			redirectUris: [HA_REDIRECT],
			requirePkce: false,
		});
		const connectHa = async () => {
			const { requestId } = await k.oauth.createRequest({
				clientId: made.client.clientId,
				redirectUri: HA_REDIRECT,
			});
			const approved = await k.oauth.approve(deniz.actor, requestId);
			return k.oauth.exchangeCode({
				client: { clientId: made.client.clientId, clientSecret: made.clientSecret },
				code: approved.code,
				redirectUri: HA_REDIRECT,
			});
		};
		const tokens = await connectHa();
		const stranger = await k.member('member');
		await expect(
			k.runner.invoke('core.deleteOAuthClient', { clientId: made.client.id }, stranger.actor),
		).rejects.toMatchObject({ code: 'not_found' });
		expect(await k.apiTokens.authenticate(tokens.accessToken)).not.toBeNull();

		const open = await k.oauth.createRequest({
			clientId: made.client.clientId,
			redirectUri: HA_REDIRECT,
		});
		const result = await k.runner.invoke(
			'core.deleteOAuthClient',
			{ clientId: made.client.id },
			deniz.actor,
		);
		expect(result.status).toBe('applied');
		expect(await k.apiTokens.authenticate(tokens.accessToken)).toBeNull();
		expect(
			code(
				await failure(
					k.oauth.refresh({
						client: { clientId: made.client.clientId, clientSecret: made.clientSecret },
						refreshToken: tokens.refreshToken,
					}),
				),
			),
		).toBe('invalid_client');
		expect(await k.oauth.listClients(deniz.actor)).toEqual([]);
		// The app is gone for what was waiting on it, too, and can not ask again.
		await expect(k.oauth.getRequest(deniz.actor, open.requestId)).rejects.toMatchObject({
			code: 'gone',
		});
		expect(
			code(
				await failure(
					k.oauth.createRequest({ clientId: made.client.clientId, redirectUri: HA_REDIRECT }),
				),
			),
		).toBe('invalid_request');
		const audit = await tables()
			.selectFrom('core_audit_log')
			.select(['action_id', 'target'])
			.where('action_id', '=', 'core.deleteOAuthClient')
			.execute();
		expect(audit).toEqual([{ action_id: 'core.deleteOAuthClient', target: made.client.id }]);

		const second = await k.oauth.createClient(deniz.actor, {
			name: 'Again',
			redirectUris: [REDIRECT],
		});
		expect(
			(await k.runner.invoke('core.deleteOAuthClient', { clientId: second.client.id }, admin.actor))
				.status,
		).toBe('applied');
	});
});

describe('clearing out', () => {
	it('removes expired requests, codes and tokens and dynamic apps nobody approved in a day', async () => {
		const { tokens, client } = await connect();
		const stale = await publicClient('dynamic');
		const kept = await publicClient('metadata');
		await ask(stale.clientId);
		const count = async (
			table:
				| 'core_oauth_requests'
				| 'core_oauth_codes'
				| 'core_oauth_tokens'
				| 'core_oauth_clients',
		) =>
			Number(
				(
					await tables()
						.selectFrom(table)
						.select((eb) => eb.fn.countAll<number>().as('n'))
						.executeTakeFirstOrThrow()
				).n,
			);
		expect(await count('core_oauth_clients')).toBe(3);
		k.clock.advance(11 * 60 * 1000);
		await k.oauth.cleanup();
		expect(await count('core_oauth_requests')).toBe(0);
		expect(await count('core_oauth_codes')).toBe(0);
		// The access token is still within its hour; the apps are within their day.
		expect(await count('core_oauth_tokens')).toBe(2);
		expect(await count('core_oauth_clients')).toBe(3);
		k.clock.advance(HOUR);
		await k.oauth.cleanup();
		expect(await count('core_oauth_tokens')).toBe(1);
		k.clock.advance(DAY);
		await k.oauth.cleanup();
		const clients = await tables().selectFrom('core_oauth_clients').select('id').execute();
		// Approved ones stay (this one has a grant); the unapproved dynamic one goes; an app named
		// by an address is the later registration path's to purge.
		expect(clients.map((c) => c.id).sort()).toEqual([client.id, kept.id].sort());
		expect(await k.apiTokens.authenticate(tokens.accessToken)).toBeNull();
	});

	it('runs from the queue once a day and keeps itself scheduled', async () => {
		const stale = await publicClient('dynamic');
		k.clock.advance(25 * HOUR);
		await k.worker.drain();
		expect(
			await tables()
				.selectFrom('core_oauth_clients')
				.select('id')
				.where('id', '=', stale.id)
				.execute(),
		).toEqual([]);
		const pending = await tables().selectFrom('core_oauth_clients').select('id').execute();
		expect(pending).toEqual([]);
	});
});

describe('after a restore', () => {
	it('deletes every secret an app holds and says that the apps must connect again', async () => {
		const first = await connect();
		const second = await connect(admin);
		const waiting = await ask((await publicClient()).clientId);
		const report = await k.reconcileRestore(null);
		expect(report.aiAppsReset).toBe(2);
		for (const table of ['core_oauth_tokens', 'core_oauth_codes', 'core_oauth_requests'] as const)
			expect(await tables().selectFrom(table).selectAll().execute()).toEqual([]);
		expect(await k.apiTokens.authenticate(first.tokens.accessToken)).toBeNull();
		expect(await k.apiTokens.authenticate(second.tokens.accessToken)).toBeNull();
		await expect(k.oauth.getRequest(deniz.actor, waiting.requestId)).rejects.toMatchObject({
			code: 'gone',
		});
		// The grants stay listed; the app starts a new sign-in and gets in again.
		const listed = await k.apiTokens.list(deniz.actor);
		expect(listed).toHaveLength(1);
		const { requestId, verifier } = await ask(first.client.clientId);
		const approved = await k.oauth.approve(deniz.actor, requestId);
		const again = await k.oauth.exchangeCode({
			client: { clientId: first.client.clientId },
			code: approved.code,
			redirectUri: REDIRECT,
			codeVerifier: verifier,
		});
		expect(await k.apiTokens.authenticate(again.accessToken)).not.toBeNull();
		await k.worker.drain();
		const notes = await tables()
			.selectFrom('core_notifications')
			.select(['title_key', 'member_id'])
			.where('title_key', '=', 'app:notify_backup_restored_ai_apps_title')
			.execute();
		expect(notes.map((n) => n.member_id)).toEqual([admin.member.id]);
	});

	it('keeps an app removed after the backup removed, and a grant revoked after it revoked', async () => {
		const made = await k.oauth.createClient(deniz.actor, { name: 'HA', redirectUris: [REDIRECT] });
		const grant = await connect();
		// The database the restore set aside knows both were ended afterwards.
		const later = await createTestKernel({ publicUrl: BASE });
		const row = await tables()
			.selectFrom('core_oauth_clients')
			.selectAll()
			.where('id', '=', made.client.id)
			.executeTakeFirstOrThrow();
		const grantRow = await tables()
			.selectFrom('core_api_tokens')
			.selectAll()
			.where('id', '=', grant.grantId)
			.executeTakeFirstOrThrow();
		await later.ctx.db
			.withTables<CoreTables>()
			.insertInto('core_members')
			.values({
				id: deniz.member.id,
				display_name: 'D',
				role_id: 'member',
				about: null,
				color: '#000000',
				locale: null,
				created_at: 1,
				updated_at: 1,
				archived_at: null,
			})
			.execute();
		const target = later.ctx.db.withTables<CoreTables>();
		await target
			.insertInto('core_oauth_clients')
			.values({ ...row, revoked_at: 5 })
			.execute();
		await target
			.insertInto('core_oauth_clients')
			.values({
				...(await tables()
					.selectFrom('core_oauth_clients')
					.selectAll()
					.where('id', '=', grant.client.id)
					.executeTakeFirstOrThrow()),
			})
			.execute();
		await target
			.insertInto('core_api_tokens')
			.values({ ...grantRow, revoked_at: 6 })
			.execute();
		await k.reconcileRestore(later.ctx.db);
		const clientNow = await tables()
			.selectFrom('core_oauth_clients')
			.select('revoked_at')
			.where('id', '=', made.client.id)
			.executeTakeFirstOrThrow();
		expect(clientNow.revoked_at).toBe(5);
		const grantNow = await tables()
			.selectFrom('core_api_tokens')
			.select('revoked_at')
			.where('id', '=', grant.grantId)
			.executeTakeFirstOrThrow();
		expect(grantNow.revoked_at).toBe(6);
		await later.close();
	});
});
