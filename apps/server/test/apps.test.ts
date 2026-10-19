import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import type { Actor, MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { admits, authenticate, authenticateApp } from '../src/http/authenticate.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();
const BASE = 'http://localhost:3000';
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;

beforeEach(async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-apps-'));
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
			'x-forwarded-for': `10.3.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`,
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(cookie && { cookie }),
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return {
		status: res.status,
		body: text ? JSON.parse(text) : null,
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

async function setup() {
	const made = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: 'correct horse battery',
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	expect(made.status).toBe(201);
	const signIn = await call('POST', '/api/auth/sign-in/email', {
		email: 'parent@example.com',
		password: 'correct horse battery',
	});
	return { adminId: made.body.id as string, cookie: signIn.cookie };
}

async function addMember(cookie: string, displayName: string, roleId: string) {
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
		{ email: `${displayName.toLowerCase()}@example.com`, password: 'a long enough password' },
		cookie,
	);
	return id;
}

async function signInAs(displayName: string) {
	const res = await call('POST', '/api/auth/sign-in/email', {
		email: `${displayName.toLowerCase()}@example.com`,
		password: 'a long enough password',
	});
	expect(res.status).toBe(200);
	return res.cookie;
}

const bearer = (secret: string, extra: Record<string, string> = {}) =>
	new Headers({ authorization: `Bearer ${secret}`, ...extra });

describe('the connected apps routes', () => {
	it('lets an admin add an app, shows its key once, and never lists a secret', async () => {
		const { cookie } = await setup();
		const created = await call(
			'POST',
			'/api/v1/apps',
			{ name: 'Home Assistant', roleId: 'member', mode: 'apply', actsFor: [] },
			cookie,
		);
		expect(created.status).toBe(201);
		const secret = created.body.secret as string;
		expect(secret.startsWith('famos_')).toBe(true);
		expect(created.body.app.tokens).toHaveLength(1);
		expect(created.body.app.tokens[0].expiresAt).toBeNull();
		const listed = await call('GET', '/api/v1/apps', undefined, cookie);
		expect(listed.status).toBe(200);
		expect(listed.body.apps).toHaveLength(1);
		expect(JSON.stringify(listed.body)).not.toContain(secret);
		expect(JSON.stringify(listed.body)).not.toContain('token_hash');
	});

	it('turns away everyone who is not an admin signed in with a password', async () => {
		const { cookie } = await setup();
		const memberId = await addMember(cookie, 'Leo', 'member');
		const memberCookie = await signInAs('Leo');
		const body = { name: 'X', roleId: 'member', mode: 'apply', actsFor: [] };
		expect((await call('GET', '/api/v1/apps')).status).toBe(401);
		for (const who of [memberCookie]) {
			expect((await call('GET', '/api/v1/apps', undefined, who)).status).toBe(403);
			expect((await call('POST', '/api/v1/apps', body, who)).status).toBe(403);
		}
		expect(memberId).toBeTruthy();
		// An admin signed in with a PIN is not an admin here: the key is a credential.
		const adminActor: Actor = {
			kind: 'member',
			memberId: (await runtime.kernel.ctx.family.members())[0]?.id as MemberId,
			roleId: 'admin',
			pin: true,
		};
		await expect(runtime.kernel.apps.list(adminActor)).rejects.toMatchObject({ code: 'forbidden' });
		expect((await call('GET', '/api/v1/apps', undefined, cookie)).status).toBe(200);
	});

	it('rotates a key and revokes an app', async () => {
		const { cookie } = await setup();
		const created = await call(
			'POST',
			'/api/v1/apps',
			{ name: 'Script', roleId: 'member', mode: 'suggest', actsFor: [] },
			cookie,
		);
		const appId = created.body.app.id as string;
		const first = created.body.secret as string;
		const second = await call('POST', `/api/v1/apps/${appId}/tokens`, { name: 'Second' }, cookie);
		expect(second.status).toBe(201);
		const firstId = created.body.app.tokens[0].id as string;
		expect(
			(await call('DELETE', `/api/v1/apps/${appId}/tokens/${firstId}`, undefined, cookie)).status,
		).toBe(200);
		expect((await authenticateApp(runtime.kernel, bearer(first))).outcome).toBe('unknown');
		expect((await authenticateApp(runtime.kernel, bearer(second.body.secret))).outcome).toBe('ok');
		expect((await call('DELETE', `/api/v1/apps/${appId}`, undefined, cookie)).status).toBe(200);
		expect((await authenticateApp(runtime.kernel, bearer(second.body.secret))).outcome).toBe(
			'unknown',
		);
		const listed = await call('GET', '/api/v1/apps', undefined, cookie);
		expect(listed.body.apps[0].revokedAt).not.toBeNull();
	});
});

describe('the door for apps', () => {
	async function appFor(
		roleId: string,
		mode: 'apply' | 'suggest',
		actsFor: string[],
		cookie: string,
	) {
		const created = await call(
			'POST',
			'/api/v1/apps',
			{ name: 'Home Assistant', roleId, mode, actsFor },
			cookie,
		);
		return created.body.secret as string;
	}

	it('takes a bearer and reads who the app acts for from the header', async () => {
		const { cookie } = await setup();
		const leoId = await addMember(cookie, 'Leo', 'member');
		const ivyId = await addMember(cookie, 'Ivy', 'member');
		const secret = await appFor('member', 'apply', [leoId], cookie);

		const alone = await authenticateApp(runtime.kernel, bearer(secret));
		expect(alone).toMatchObject({
			outcome: 'ok',
			caller: { actor: { kind: 'app' }, memberId: null },
		});

		const forLeo = await authenticateApp(
			runtime.kernel,
			bearer(secret, { 'x-familyos-on-behalf-of': leoId }),
		);
		expect(forLeo).toMatchObject({
			outcome: 'ok',
			caller: { actor: { kind: 'member', memberId: leoId, via: { mode: 'apply' } } },
		});

		await expect(
			authenticateApp(runtime.kernel, bearer(secret, { 'x-familyos-on-behalf-of': ivyId })),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			authenticateApp(
				runtime.kernel,
				bearer(secret, { 'x-familyos-on-behalf-of': `${leoId}, ${leoId}` }),
			),
		).rejects.toMatchObject({ code: 'forbidden' });
		expect((await authenticateApp(runtime.kernel, new Headers())).outcome).toBe('missing');
		expect((await authenticateApp(runtime.kernel, bearer('famos_nope'))).outcome).toBe('unknown');
		// A cookie is never read here.
		expect((await authenticateApp(runtime.kernel, new Headers({ cookie }))).outcome).toBe(
			'missing',
		);
	});

	it('is closed to the other credentials, and they are closed to it', async () => {
		const { adminId, cookie } = await setup();
		const secret = await appFor('admin', 'apply', [adminId], cookie);

		// A personal (MCP) key is not an app key.
		const personal = await runtime.kernel.apiTokens.create(
			{ kind: 'member', memberId: adminId as MemberId, roleId: 'admin' },
			{ name: 'mine', scope: 'read' },
		);
		expect((await authenticateApp(runtime.kernel, bearer(personal.secret))).outcome).toBe(
			'unknown',
		);

		// An app key is not a personal key: the AI door does not know it.
		expect((await call('PUT', '/api/v1/mcp/settings', { enabled: true }, cookie)).status).toBe(200);
		const mcp = await app.request(`${BASE}/mcp`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'x-forwarded-for': '10.9.1.1',
				authorization: `Bearer ${secret}`,
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		});
		expect(mcp.status).toBe(401);

		// The app's own API takes a session, not a bearer.
		const viaApi = await call('GET', '/api/v1/core/members', undefined, undefined);
		expect(viaApi.status).toBe(401);
		const withHeader = await app.request(`${BASE}/api/v1/core/members`, {
			headers: { authorization: `Bearer ${secret}`, 'x-forwarded-for': '10.9.1.2' },
		});
		expect(withHeader.status).toBe(400);
		await expect(
			authenticate(
				{ kernel: runtime.kernel, identity: runtime.identity },
				new Headers({ authorization: `Bearer ${secret}` }),
				'session',
			),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('admits a member through an app only at its own door', () => {
		const through: Actor = {
			kind: 'member',
			memberId: 'member_a' as MemberId,
			roleId: 'member',
			via: { appId: 'app_1', appRoleId: 'member', mode: 'apply' },
		};
		const plain: Actor = { kind: 'member', memberId: 'member_a' as MemberId, roleId: 'member' };
		const app1: Actor = { kind: 'app', appId: 'app_1', roleId: 'member', mode: 'apply' };
		expect(admits('api', through)).toBe(true);
		expect(admits('api', app1)).toBe(true);
		expect(admits('api', plain)).toBe(false);
		expect(admits('session', through)).toBe(false);
		expect(admits('session', app1)).toBe(false);
		expect(admits('session', plain)).toBe(true);
		expect(admits('mcp', through)).toBe(false);
		expect(admits('mcp', app1)).toBe(false);
		expect(admits('api', { kind: 'system', source: 'x' })).toBe(false);
	});

	it('a paused or revoked app is turned away at once, and an archived member is refused', async () => {
		const { cookie } = await setup();
		const leoId = await addMember(cookie, 'Leo', 'member');
		const created = await call(
			'POST',
			'/api/v1/apps',
			{ name: 'HA', roleId: 'member', mode: 'apply', actsFor: [leoId] },
			cookie,
		);
		const secret = created.body.secret as string;
		const appId = created.body.app.id as string;
		await call('POST', `/api/v1/apps/${appId}/pause`, undefined, cookie);
		expect((await authenticateApp(runtime.kernel, bearer(secret))).outcome).toBe('unknown');
		await call('POST', `/api/v1/apps/${appId}/resume`, undefined, cookie);
		expect((await authenticateApp(runtime.kernel, bearer(secret))).outcome).toBe('ok');
		await call('POST', '/api/v1/actions/core.archiveMember', { memberId: leoId }, cookie);
		await expect(
			authenticateApp(runtime.kernel, bearer(secret, { 'x-familyos-on-behalf-of': leoId })),
		).rejects.toMatchObject({ code: 'forbidden' });
		expect((await authenticateApp(runtime.kernel, bearer(secret))).outcome).toBe('ok');
	});
});
