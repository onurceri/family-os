import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import type { Actor, ExtensionDefinition, MemberId } from '@famos/sdk';
import { defineTestExtension } from '@famos/testing';
import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { createRealtimeHub } from '../src/http/realtime.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime, seedAi } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const BASE = 'http://localhost:3000';
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;

async function boot(extraExtensions: readonly ExtensionDefinition[] = []) {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-http-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
		extensions: [...extensions, ...extraExtensions],
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
		publicUrl: 'https://famos.example',
		appVersion: APP_VERSION,
		secureCookies: false,
		// In-process requests come from 127.0.0.1; each test call rotates X-Forwarded-For.
		trustedProxies: ['127.0.0.1'],
		boot: 'boot-1',
	});
}
beforeEach(() => boot());
afterEach(() => runtime.close());

let ip = 0;
async function call(
	method: string,
	path: string,
	body?: unknown,
	cookie?: string,
	extraHeaders: Record<string, string> = {},
) {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			// A fresh address per request (rate limits are per address), always a valid one.
			'x-forwarded-for': `10.1.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`,
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(cookie && { cookie }),
			...extraHeaders,
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return {
		status: res.status,
		headers: res.headers,
		body: text ? JSON.parse(text) : null,
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

async function setupAndSignIn() {
	const setup = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: 'correct horse battery',
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	expect(setup.status).toBe(201);
	const signIn = await call('POST', '/api/auth/sign-in/email', {
		email: 'parent@example.com',
		password: 'correct horse battery',
	});
	expect(signIn.status).toBe(200);
	return { admin: setup.body, cookie: signIn.cookie };
}

/** A parent marks this "device" as a family device; returns the device cookie. */
async function trustDevice(adminCookie: string) {
	const res = await call(
		'POST',
		'/api/v1/core/devices/trust',
		{ name: 'Kitchen tablet' },
		adminCookie,
	);
	expect(res.status).toBe(201);
	expect(res.cookie).toMatch(/^famos_device=/);
	return { device: res.body, deviceCookie: res.cookie };
}

async function addChildWithPin(adminCookie: string) {
	const created = await call(
		'POST',
		'/api/v1/actions/core.createMember',
		{ displayName: 'Kid', roleId: 'supervised' },
		adminCookie,
	);
	expect(created.body.status).toBe('applied');
	const kid = created.body.output;
	expect(
		(await call('PUT', `/api/v1/core/members/${kid.id}/pin`, { pin: '2468' }, adminCookie)).status,
	).toBe(200);
	return kid;
}

describe('HTTP API', () => {
	it('tells anyone which extensions it runs, with a fingerprint', async () => {
		const res = await call('GET', '/api/v1/core/extensions/loaded');
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
		expect(res.body.extensions.map((e: { id: string }) => e.id).sort()).toEqual(
			extensions.map((e) => e.id).sort(),
		);
		expect(res.body.extensions.find((e: { id: string }) => e.id === 'core')).toBeUndefined();
	});

	it('serves health and requires setup on a fresh install', async () => {
		// `boot` names this start: an app waiting for a restart reloads when it changes.
		expect((await call('GET', '/health')).body).toMatchObject({ status: 'ok', boot: 'boot-1' });
		expect((await call('GET', '/api/v1/core/setup')).body).toMatchObject({
			needsSetup: true,
			needsCode: true,
		});
	});

	it('refuses setup without the one-time code', async () => {
		const body = {
			displayName: 'Intruder',
			email: 'x@example.com',
			password: 'correct horse battery',
			locale: 'en',
		};
		expect(runtime.config.setupCode.length).toBeGreaterThanOrEqual(12);
		expect((await call('POST', '/api/v1/core/setup', body)).status).toBe(403);
		expect((await call('POST', '/api/v1/core/setup', { ...body, setupCode: 'guess' })).status).toBe(
			403,
		);
		expect((await call('GET', '/api/v1/core/setup')).body.needsSetup).toBe(true);
	});

	it('runs setup once, then signs the admin in', async () => {
		const { admin, cookie } = await setupAndSignIn();
		expect((await call('GET', '/api/v1/core/setup')).body.needsSetup).toBe(false);
		expect(
			(
				await call('POST', '/api/v1/core/setup', {
					displayName: 'X',
					email: 'x@example.com',
					password: 'correct horse battery',
					locale: 'en',
					setupCode: runtime.config.setupCode,
				})
			).status,
		).toBe(409);
		const me = await call('GET', '/api/v1/core/me', undefined, cookie);
		expect(me.body).toMatchObject({ id: admin.id, roleId: 'admin' });
		expect(me.body.capabilities).toContain('core.members.manage');
	});

	it('rejects unauthenticated calls and invalid input', async () => {
		expect((await call('GET', '/api/v1/core/me')).status).toBe(401);
		const { cookie } = await setupAndSignIn();
		const bad = await call(
			'POST',
			'/api/v1/actions/core.createMember',
			{ displayName: '', roleId: 'member' },
			cookie,
		);
		expect(bad.status).toBe(400);
		expect(bad.body.error.code).toBe('bad_request');
	});

	it('lets an admin add a child with a PIN; the child cannot run admin actions', async () => {
		const { cookie } = await setupAndSignIn();
		const kid = await addChildWithPin(cookie);
		const { deviceCookie } = await trustDevice(cookie);
		const pin = await call(
			'POST',
			'/api/auth/sign-in/pin',
			{ memberId: kid.id, pin: '2468' },
			deviceCookie,
		);
		expect(pin.status).toBe(200);

		const kidMe = await call('GET', '/api/v1/core/me', undefined, pin.cookie);
		expect(kidMe.body).toMatchObject({ id: kid.id, roleId: 'supervised' });
		const members = await call('GET', '/api/v1/core/members', undefined, pin.cookie);
		expect(members.body).toHaveLength(2);
		const forbidden = await call(
			'POST',
			'/api/v1/actions/core.createMember',
			{ displayName: 'Nope', roleId: 'admin' },
			pin.cookie,
		);
		expect(forbidden.status).toBe(403);
	});

	it('archived members lose access immediately', async () => {
		const { cookie } = await setupAndSignIn();
		const kid = await addChildWithPin(cookie);
		const { deviceCookie } = await trustDevice(cookie);
		const pin = await call(
			'POST',
			'/api/auth/sign-in/pin',
			{ memberId: kid.id, pin: '2468' },
			deviceCookie,
		);
		await call('POST', '/api/v1/actions/core.archiveMember', { memberId: kid.id }, cookie);
		expect((await call('GET', '/api/v1/core/me', undefined, pin.cookie)).status).toBe(401);
	});

	it('shows profiles and accepts PINs only on trusted family devices', async () => {
		const { cookie } = await setupAndSignIn();
		const kid = await addChildWithPin(cookie);
		const pinBody = { memberId: kid.id, pin: '2468' };

		// Unknown device: no names, no PIN guessing, no self-trusting.
		expect((await call('GET', '/api/v1/core/profiles')).status).toBe(401);
		expect((await call('GET', '/api/v1/core/devices/current')).body).toEqual({ device: null });
		expect((await call('POST', '/api/auth/sign-in/pin', pinBody)).status).toBe(403);
		expect((await call('POST', '/api/v1/core/devices/trust', { name: 'Sneaky' })).status).toBe(401);

		const { device, deviceCookie } = await trustDevice(cookie);
		const profiles = await call('GET', '/api/v1/core/profiles', undefined, deviceCookie);
		expect(profiles.status).toBe(200);
		// Admins sign in with a password, so only PIN roles appear in the picker.
		expect(profiles.body.map((p: { displayName: string }) => p.displayName)).toEqual(['Kid']);
		const current = await call('GET', '/api/v1/core/devices/current', undefined, deviceCookie);
		expect(current.body.device).toMatchObject({ name: 'Kitchen tablet' });

		// A child cannot trust devices; revoking a device closes it immediately.
		const kidSession = (await call('POST', '/api/auth/sign-in/pin', pinBody, deviceCookie)).cookie;
		expect(
			(await call('POST', '/api/v1/core/devices/trust', { name: 'Mine' }, kidSession)).status,
		).toBe(403);
		expect((await call('GET', '/api/v1/core/devices', undefined, cookie)).body).toHaveLength(1);
		expect(
			(await call('POST', '/api/v1/actions/core.revokeDevice', { deviceId: device.id }, cookie))
				.status,
		).toBe(200);
		expect((await call('GET', '/api/v1/core/profiles', undefined, deviceCookie)).status).toBe(401);
		expect((await call('POST', '/api/auth/sign-in/pin', pinBody, deviceCookie)).status).toBe(403);
		// Sessions signed in on the revoked device end with it.
		expect((await call('GET', '/api/v1/core/me', undefined, kidSession)).status).toBe(401);
	});

	it('forgetting a device removes its cookie instead of refreshing it', async () => {
		const { cookie } = await setupAndSignIn();
		const { deviceCookie } = await trustDevice(cookie);
		const forgotten = await call('POST', '/api/v1/core/devices/forget', undefined, deviceCookie);
		expect(forgotten.status).toBe(200);
		const setCookies = forgotten.headers
			.getSetCookie()
			.filter((h) => h.startsWith('famos_device='));
		// Exactly one header, and it expires the cookie (not a second one that re-sets it).
		expect(setCookies).toHaveLength(1);
		expect(setCookies[0]).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
	});

	it('forgetting a device revokes it: it leaves the list and its PIN sessions end', async () => {
		const { cookie } = await setupAndSignIn();
		const kid = await addChildWithPin(cookie);
		const { device, deviceCookie } = await trustDevice(cookie);
		const pin = await call(
			'POST',
			'/api/auth/sign-in/pin',
			{ memberId: kid.id, pin: '2468' },
			deviceCookie,
		);
		expect((await call('GET', '/api/v1/core/me', undefined, pin.cookie)).status).toBe(200);

		const forgotten = await call('POST', '/api/v1/core/devices/forget', undefined, deviceCookie);
		expect(forgotten.status).toBe(200);
		const list = await call('GET', '/api/v1/core/devices', undefined, cookie);
		expect(list.body.map((d: { id: string }) => d.id)).not.toContain(device.id);
		expect((await call('GET', '/api/v1/core/me', undefined, pin.cookie)).status).toBe(401);
		// The old cookie no longer opens the profile picker.
		expect((await call('GET', '/api/v1/core/profiles', undefined, deviceCookie)).status).toBe(401);
	});

	it('removing a member frees their email and ends their sign-in', async () => {
		const { cookie } = await setupAndSignIn();
		const made = await call(
			'POST',
			'/api/v1/actions/core.createMember',
			{ displayName: 'Ece', roleId: 'member' },
			cookie,
		);
		const ece = made.body.output;
		const login = { email: 'ece@example.com', password: 'correct horse battery' };
		await call('PUT', `/api/v1/core/members/${ece.id}/password`, login, cookie);
		const session = await call('POST', '/api/auth/sign-in/email', login);
		expect(session.status).toBe(200);

		// Another member cannot take the email, with a specific reason.
		const other = await call(
			'POST',
			'/api/v1/actions/core.createMember',
			{ displayName: 'Can', roleId: 'member' },
			cookie,
		);
		const clash = await call(
			'PUT',
			`/api/v1/core/members/${other.body.output.id}/password`,
			login,
			cookie,
		);
		expect(clash.status).toBe(409);
		expect(clash.body.error.details).toEqual({ reason: 'email_taken' });

		await call('POST', '/api/v1/actions/core.archiveMember', { memberId: ece.id }, cookie);
		expect((await call('GET', '/api/v1/core/me', undefined, session.cookie)).status).toBe(401);
		expect((await call('POST', '/api/auth/sign-in/email', login)).status).not.toBe(200);
		const reuse = await call(
			'PUT',
			`/api/v1/core/members/${other.body.output.id}/password`,
			login,
			cookie,
		);
		expect(reuse.status).toBe(200);
	});

	it('lets an admin have a PIN on a family device, which never administers', async () => {
		const { admin, cookie: first } = await setupAndSignIn();
		const { deviceCookie } = await trustDevice(first);
		expect(
			(await call('PUT', `/api/v1/core/members/${admin.id}/pin`, { pin: '8642' }, first)).status,
		).toBe(200);
		// A new PIN signs the person out everywhere; the admin signs in with the password again.
		const cookie = (
			await call('POST', '/api/auth/sign-in/email', {
				email: 'parent@example.com',
				password: 'correct horse battery',
			})
		).cookie;
		const profiles = await call('GET', '/api/v1/core/profiles', undefined, deviceCookie);
		expect(profiles.body.map((p: { id: string }) => p.id)).toContain(admin.id);
		const pinSession = (
			await call('POST', '/api/auth/sign-in/pin', { memberId: admin.id, pin: '8642' }, deviceCookie)
		).cookie;
		const me = await call('GET', '/api/v1/core/me', undefined, pinSession);
		expect(me.status).toBe(200);
		expect(me.body.capabilities).toContain('core.drafts.approve');
		expect(me.body.capabilities).not.toContain('core.members.manage');
		const refused = await call(
			'POST',
			'/api/v1/actions/core.createMember',
			{ displayName: 'Pat', roleId: 'member' },
			pinSession,
		);
		expect(refused.status).toBe(403);
		expect((await call('GET', '/api/v1/core/members', undefined, pinSession)).status).toBe(200);
		// With the password, the same admin administers again.
		expect((await call('GET', '/api/v1/core/me', undefined, cookie)).body.capabilities).toContain(
			'core.members.manage',
		);
	});

	it('ends sessions when a PIN or password changes, a role loses PIN sign-in, or on request', async () => {
		const { admin, cookie } = await setupAndSignIn();
		const kid = await addChildWithPin(cookie);
		const { deviceCookie } = await trustDevice(cookie);
		const signInKid = async (pin = '2468') =>
			(await call('POST', '/api/auth/sign-in/pin', { memberId: kid.id, pin }, deviceCookie)).cookie;
		const status = async (session: string) =>
			(await call('GET', '/api/v1/core/me', undefined, session)).status;

		const first = await signInKid();
		await call('PUT', `/api/v1/core/members/${kid.id}/pin`, { pin: '1357' }, cookie);
		expect(await status(first)).toBe(401);

		// A PIN session never outlives its role's PIN sign-in.
		const second = await signInKid('1357');
		expect(await status(second)).toBe(200);
		const role = await call(
			'POST',
			'/api/v1/actions/core.createRole',
			{ name: 'Passwords only', base: 'member', overrides: { 'core.signIn.pin': false } },
			cookie,
		);
		await call(
			'POST',
			'/api/v1/actions/core.updateMember',
			{ memberId: kid.id, roleId: role.body.output.id },
			cookie,
		);
		expect(await status(second)).toBe(401);

		// Admins changing their own password stay signed in; "sign out everywhere" ends it.
		const password = { email: 'parent@example.com', password: 'another horse battery' };
		await call('PUT', `/api/v1/core/members/${admin.id}/password`, password, cookie);
		expect(await status(cookie)).toBe(200);
		expect((await call('POST', '/api/v1/core/sessions/end', undefined, cookie)).status).toBe(200);
		expect(await status(cookie)).toBe(401);
	});

	it('locks PIN sign-in for a member after five wrong PINs', async () => {
		const { cookie } = await setupAndSignIn();
		const kid = await addChildWithPin(cookie);
		const { deviceCookie } = await trustDevice(cookie);
		const attempt = (pin: string) =>
			call('POST', '/api/auth/sign-in/pin', { memberId: kid.id, pin }, deviceCookie);
		for (let i = 0; i < 5; i++) expect((await attempt('0000')).status).toBe(401);
		expect((await attempt('2468')).status).toBe(429);
	});

	it('answers "turned off" for a turned-off extension and hides it from members', async () => {
		const { cookie } = await setupAndSignIn();
		expect((await call('GET', '/api/v1/lists/tasks', undefined, cookie)).status).toBe(200);
		const off = await call(
			'POST',
			'/api/v1/actions/core.setFeatureEnabled',
			{ extensionId: 'lists', enabled: false },
			cookie,
		);
		expect(off.body.status).toBe('applied');
		const route = await call('GET', '/api/v1/lists/tasks', undefined, cookie);
		expect(route).toMatchObject({ status: 404, body: { error: { code: 'feature_off' } } });
		const action = await call('POST', '/api/v1/actions/lists.addTask', { title: 'Nope' }, cookie);
		expect(action.body.error.code).toBe('feature_off');
		const me = await call('GET', '/api/v1/core/me', undefined, cookie);
		expect(me.body.disabledExtensions).toEqual(['lists']);
		expect(me.body.capabilities).not.toContain('lists.view');
	});

	it('serves the OpenAPI document to signed-in members only', async () => {
		const out = await call('GET', '/api/openapi.json');
		expect(out.status).toBe(401);
		expect(out.body.paths).toBeUndefined();
		const { cookie } = await setupAndSignIn();
		const doc = await call('GET', '/api/openapi.json', undefined, cookie);
		expect(doc.status).toBe(200);
		expect(doc.headers.get('cache-control')).toBe('no-store');
		expect(doc.body.paths['/api/v1/actions/core.createMember'].post.operationId).toBe(
			'core.createMember',
		);
	});

	it('lets parents manage AI settings without ever returning keys', async () => {
		expect((await call('GET', '/api/v1/ai/settings')).status).toBe(401);
		const { cookie } = await setupAndSignIn();
		const added = await call(
			'POST',
			'/api/v1/actions/core.addAiProvider',
			{ name: 'OpenRouter', kind: 'openrouter' },
			cookie,
		);
		expect(added.status).toBe(200);
		expect(added.body.output).toMatchObject({ kind: 'openrouter', hasKey: false });
		const keyed = await call(
			'PUT',
			`/api/v1/ai/providers/${added.body.output.id}/key`,
			{ apiKey: 'sk-or-secret' },
			cookie,
		);
		expect(keyed.status).toBe(200);
		expect(keyed.body).toMatchObject({ kind: 'openrouter', hasKey: true, keyReadable: true });
		const created = { body: { id: added.body.output.id as string } };
		const model = { providerId: created.body.id, model: 'google/gemini-flash' };
		const roles = await call(
			'POST',
			'/api/v1/actions/core.setAiRoles',
			{ fast: model, vision: model, smart: model },
			cookie,
		);
		expect(roles.status).toBe(200);
		let settings = await call('GET', '/api/v1/ai/settings', undefined, cookie);
		expect(settings.body.roles.smart).toEqual(model);
		// Speech to text and voice privacy are new: older clients leave them out.
		expect(settings.body.roles.transcribe).toBeNull();
		expect(settings.body.privacy.sendVoice).toBe(true);
		const speech = { providerId: created.body.id, model: 'whisper-large-v3' };
		await call(
			'POST',
			'/api/v1/actions/core.setAiRoles',
			{ fast: model, vision: model, smart: model, transcribe: speech },
			cookie,
		);
		await call(
			'POST',
			'/api/v1/actions/core.setAiPrivacy',
			{ ...settings.body.privacy, sendVoice: false },
			cookie,
		);
		settings = await call('GET', '/api/v1/ai/settings', undefined, cookie);
		expect(settings.body.roles.transcribe).toEqual(speech);
		expect(settings.body.privacy.sendVoice).toBe(false);
		expect(JSON.stringify(settings.body)).not.toContain('sk-or-secret');
		expect((await call('GET', '/api/v1/ai/usage', undefined, cookie)).body.total.calls).toBe(0);
	});

	it('keeps a provider key in a route that records itself and never shows the key', async () => {
		const { cookie } = await setupAndSignIn();
		const added = await call(
			'POST',
			'/api/v1/actions/core.addAiProvider',
			{ name: 'Home', kind: 'openai-compatible', baseUrl: 'https://llm.example.com/v1' },
			cookie,
		);
		const id = added.body.output.id as string;
		const key = `/api/v1/ai/providers/${id}/key`;
		expect((await call('PUT', key, { apiKey: 'sk-secret' })).status).toBe(401);
		const keyed = await call('PUT', key, { apiKey: 'sk-secret' }, cookie);
		expect(keyed.status).toBe(200);
		expect(keyed.body).toMatchObject({ id, hasKey: true });
		expect(JSON.stringify(keyed.body)).not.toContain('sk-secret');

		// Moving the provider takes the key away; the answer says so.
		const moved = await call(
			'POST',
			'/api/v1/actions/core.updateAiProvider',
			{ providerId: id, baseUrl: 'https://other.example.com/v1' },
			cookie,
		);
		expect(moved.body.output).toMatchObject({ keyDropped: true, provider: { hasKey: false } });
		const removed = await call('PUT', key, { apiKey: null }, cookie);
		expect(removed.body).toMatchObject({ hasKey: false });

		const rows = await runtime.kernel.ctx.db
			.withTables<{
				core_audit_log: { action_id: string; target: string | null; outcome: string };
			}>()
			.selectFrom('core_audit_log')
			.select(['action_id', 'target', 'outcome'])
			.where('action_id', '=', 'ai.setProviderKey')
			.execute();
		expect(rows).toEqual([
			{ action_id: 'ai.setProviderKey', target: id, outcome: 'applied' },
			{ action_id: 'ai.setProviderKey', target: id, outcome: 'applied' },
		]);
		expect(JSON.stringify(rows)).not.toContain('sk-secret');
	});

	it('keeps the provider key and the AI choices away from a child on a family device', async () => {
		const { cookie } = await setupAndSignIn();
		const added = await call(
			'POST',
			'/api/v1/actions/core.addAiProvider',
			{ name: 'Home', kind: 'ollama' },
			cookie,
		);
		const id = added.body.output.id as string;
		const kid = await addChildWithPin(cookie);
		const { deviceCookie } = await trustDevice(cookie);
		const session = (
			await call('POST', '/api/auth/sign-in/pin', { memberId: kid.id, pin: '2468' }, deviceCookie)
		).cookie;
		const key = await call('PUT', `/api/v1/ai/providers/${id}/key`, { apiKey: 'sk-x' }, session);
		expect(key.status).toBe(403);
		const change = await call(
			'POST',
			'/api/v1/actions/core.setAiSwitches',
			{ enabled: false, off: [] },
			session,
		);
		expect(change.status).toBe(403);
		const settings = await call('GET', '/api/v1/ai/settings', undefined, cookie);
		expect(settings.body.switches.enabled).toBe(true);
		expect(settings.body.providers[0].hasKey).toBe(false);
	});

	it('lets admins choose how far the AI may use each area', async () => {
		// A sensitive area beside the real extensions.
		await runtime.close();
		await boot([defineTestExtension({ id: 'strongbox', sensitive: true })]);
		expect((await call('GET', '/api/v1/core/ai-areas')).status).toBe(401);
		const { cookie } = await setupAndSignIn();
		const list = await call('GET', '/api/v1/core/ai-areas', undefined, cookie);
		expect(list.status).toBe(200);
		expect(list.body).toContainEqual(
			expect.objectContaining({
				id: 'strongbox',
				sensitive: true,
				access: 'off',
				default: 'off',
			}),
		);
		expect(list.body).toContainEqual(
			expect.objectContaining({
				id: 'calendar',
				sensitive: false,
				access: 'any',
				default: 'any',
			}),
		);
		expect(list.body.map((a: { id: string }) => a.id)).not.toContain('core');

		const set = (body: unknown, c = cookie) =>
			call('POST', '/api/v1/actions/core.setAiAreaAccess', body, c);
		// Opening a sensitive area to any provider needs the confirmation.
		expect((await set({ extensionId: 'strongbox', access: 'any' })).status).toBe(400);
		expect((await set({ extensionId: 'core', access: 'off' })).status).toBe(400);
		expect((await set({ extensionId: 'strongbox', access: 'local' })).body.status).toBe('applied');
		expect(
			(await set({ extensionId: 'strongbox', access: 'any', confirmSensitive: true })).body.status,
		).toBe('applied');
		expect((await set({ extensionId: 'calendar', access: 'off' })).body.status).toBe('applied');
		const after = await call('GET', '/api/v1/core/ai-areas', undefined, cookie);
		expect(after.body).toContainEqual(
			expect.objectContaining({
				id: 'strongbox',
				sensitive: true,
				access: 'any',
				default: 'off',
			}),
		);
		expect(after.body).toContainEqual(
			expect.objectContaining({
				id: 'calendar',
				sensitive: false,
				access: 'off',
				default: 'any',
			}),
		);

		// Members who may not manage AI are refused.
		const kid = await addChildWithPin(cookie);
		const { deviceCookie } = await trustDevice(cookie);
		const pin = await call(
			'POST',
			'/api/auth/sign-in/pin',
			{ memberId: kid.id, pin: '2468' },
			deviceCookie,
		);
		expect((await call('GET', '/api/v1/core/ai-areas', undefined, pin.cookie)).status).toBe(403);
		expect((await set({ extensionId: 'calendar', access: 'any' }, pin.cookie)).status).toBe(403);
	});

	it('lists AI activity for admins only, newest first, without any content', async () => {
		expect((await call('GET', '/api/v1/ai/activity')).status).toBe(401);
		const { admin, cookie } = await setupAndSignIn();
		const db = runtime.kernel.ctx.db;
		const row = (n: number, areas: string | null, error: string | null, member: string | null) =>
			db
				.withTables<{ ai_usage: Record<string, unknown> }>()
				.insertInto('ai_usage')
				.values({
					id: `ai_call_${n}`,
					at: 1000 + n,
					role: 'smart',
					provider_id: 'p',
					model: 'OpenRouter / vendor/model',
					feature: 'inbox.extract',
					member_id: member,
					job_id: 'job_1',
					input_tokens: 10,
					output_tokens: 5,
					cost_micros: 2500,
					latency_ms: 40,
					error_code: error,
					areas,
				})
				.execute();
		await row(1, null, null, null);
		await row(2, '["inbox","calendar"]', null, admin.id);
		await row(3, '["inbox","lists"]', 'disabled', null);

		const first = await call('GET', '/api/v1/ai/activity?limit=2', undefined, cookie);
		expect(first.status).toBe(200);
		expect(first.body.entries.map((e: { id: string }) => e.id)).toEqual(['ai_call_3', 'ai_call_2']);
		expect(first.body.entries[0]).toMatchObject({
			feature: 'inbox.extract',
			areas: ['inbox', 'lists'],
			provider: 'OpenRouter',
			model: 'vendor/model',
			cost: 0.0025,
			errorCode: 'disabled',
			member: null,
		});
		expect(first.body.entries[1].member).toBe('Parent');
		const rest = await call(
			'GET',
			`/api/v1/ai/activity?limit=2&before=${encodeURIComponent(first.body.next)}`,
			undefined,
			cookie,
		);
		expect(rest.body.entries.map((e: { id: string }) => e.id)).toEqual(['ai_call_1']);
		expect(rest.body.entries[0].areas).toBeNull();
		expect(rest.body.next).toBeNull();
		// Only metadata: no field could hold a prompt or an answer.
		for (const entry of first.body.entries) {
			expect(Object.keys(entry).sort()).toEqual(
				[
					'areas',
					'at',
					'cost',
					'errorCode',
					'finishReason',
					'feature',
					'id',
					'inputTokens',
					'latencyMs',
					'member',
					'model',
					'outputTokens',
					'reasoningTokens',
					'provider',
					'role',
				].sort(),
			);
		}

		const kid = await addChildWithPin(cookie);
		const { deviceCookie } = await trustDevice(cookie);
		const pin = await call(
			'POST',
			'/api/auth/sign-in/pin',
			{ memberId: kid.id, pin: '2468' },
			deviceCookie,
		);
		expect((await call('GET', '/api/v1/ai/activity', undefined, pin.cookie)).status).toBe(403);
	});

	it('keeps push devices per member and accepts only known push services', async () => {
		expect((await call('GET', '/api/v1/push/key')).status).toBe(401);
		const { cookie } = await setupAndSignIn();
		const key = await call('GET', '/api/v1/push/key', undefined, cookie);
		expect(key.body.publicKey).toMatch(/^[\w-]{87}$/);

		const keys = {
			p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'),
			auth: Buffer.alloc(16, 9).toString('base64url'),
		};
		const evil = await call(
			'POST',
			'/api/v1/push/subscriptions',
			{ endpoint: 'https://127.0.0.1/hook', keys },
			cookie,
		);
		expect(evil.status).toBe(400);

		const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
		const created = await call(
			'POST',
			'/api/v1/push/subscriptions',
			{ endpoint, keys, label: 'Pixel · Chrome' },
			cookie,
		);
		expect(created.status).toBe(201);
		const devices = await call('GET', '/api/v1/push/subscriptions', undefined, cookie);
		expect(devices.body).toEqual([
			{ label: 'Pixel · Chrome', createdAt: expect.any(Number), lastSuccessAt: null },
		]);
		expect(JSON.stringify(devices.body)).not.toContain('fcm.googleapis.com');

		expect((await call('DELETE', '/api/v1/push/subscriptions', { endpoint }, cookie)).status).toBe(
			200,
		);
		expect((await call('GET', '/api/v1/push/subscriptions', undefined, cookie)).body).toEqual([]);
		expect((await call('POST', '/api/v1/push/test', undefined, cookie)).body).toEqual({ sent: 0 });
	});

	it('seeds an AI provider from the environment on first boot', async () => {
		const config = await loadConfig({
			FAMOS_DATA_DIR: runtime.config.dataDir,
			FAMOS_AI_PROVIDER: 'ollama',
			FAMOS_AI_BASE_URL: 'http://ollama:11434/v1',
			FAMOS_AI_MODEL: 'qwen3',
			FAMOS_AI_MODEL_VISION: 'qwen2.5vl',
		});
		expect(config.aiSeed?.models).toEqual({ fast: 'qwen3', vision: 'qwen2.5vl', smart: 'qwen3' });
		await seedAi({ ...runtime, config });
		const settings = await runtime.ai.get();
		expect(settings.providers).toEqual([
			expect.objectContaining({ kind: 'ollama', baseUrl: 'http://ollama:11434/v1' }),
		]);
		expect(settings.roles.vision?.model).toBe('qwen2.5vl');
	});
	it('lists notifications in the member language and lets them choose preferences', async () => {
		const { admin, cookie } = await setupAndSignIn();
		expect((await call('GET', '/api/v1/core/notifications')).status).toBe(401);

		await runtime.kernel.ctx.notify({
			kind: 'core.draftWaiting',
			to: { members: [admin.id] },
			title: { key: 'app:notify_draft_waiting_title' },
			body: { key: 'app:notify_draft_waiting_body', params: { what: 'Dentist' } },
			url: '/add',
		});
		await runtime.kernel.worker.drain();
		const list = await call('GET', '/api/v1/core/notifications?limit=10', undefined, cookie);
		expect(list.status).toBe(200);
		expect(list.body.unread).toBe(1);
		expect(list.body.items[0]).toMatchObject({
			kind: 'core.draftWaiting',
			title: 'New suggestions to review',
			body: 'Dentist',
			url: '/add',
			read: false,
		});

		// Turkish members get Turkish text.
		await call(
			'POST',
			'/api/v1/actions/core.updateMember',
			{ memberId: admin.id, locale: 'tr' },
			cookie,
		);
		const tr = await call('GET', '/api/v1/core/notifications', undefined, cookie);
		expect(tr.body.items[0].title).toBe('İncelenecek yeni öneriler');

		const read = await call('POST', '/api/v1/actions/core.markNotificationsRead', {}, cookie);
		expect(read.status).toBe(200);
		expect((await call('GET', '/api/v1/core/notifications', undefined, cookie)).body.unread).toBe(
			0,
		);

		const prefs = await call('GET', '/api/v1/core/notifications/preferences', undefined, cookie);
		// Web Push and Telegram exist but nobody has registered a device or linked an account, so they are not offered.
		// The Home Assistant app is an extension's channel: it says who can link them.
		expect(prefs.body.channels).toEqual([
			{ id: 'webpush', label: 'Telefon bildirimleri', available: false },
			{ id: 'telegram', label: 'Telegram', available: false },
			{
				id: 'homeassistant',
				label: 'Home Assistant uygulaması',
				available: false,
				hint: 'Bir yönetici sizi Home Assistant uygulamanıza bağlayabilir',
			},
		]);
		expect(prefs.body.kinds).toEqual([
			{
				id: 'core.draftWaiting',
				label: 'Onay bekleyen öneriler',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'core.draftDecided',
				label: 'Önerilerine verilen yanıtlar',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'core.backupFailed',
				label: 'Bir yedek sunucunun dışına gönderilemedi',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'core.backupRestored',
				label: 'Bir yedek geri yüklendi',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'core.autoApprovalStopped',
				label: 'Otomatik onay durduruldu',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'board.posted',
				label: 'Biri panoya yeni bir not astığında',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'calendar.reminder',
				label: 'Etkinlik hatırlatmaları',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'chores.choreDue',
				label: 'Bir ev işinin günü geldi ve sıra sende',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'records.obligationDue',
				label: 'Yaklaşan bir iş var (yenileme, bakım…)',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'inbox.itemReady',
				label: 'Paylaştığın bir şey okundu',
				defaultChannels: ['webpush', 'telegram'],
			},
			{
				id: 'lists.taskDue',
				label: 'Görev son tarihleri',
				defaultChannels: ['webpush', 'telegram'],
			},
		]);
		const quiet = { start: '22:00', end: '07:00' };
		const saved = await call(
			'POST',
			'/api/v1/actions/core.setNotificationPreferences',
			{ kinds: {}, quietHours: quiet },
			cookie,
		);
		expect(saved.status).toBe(200);
		const again = await call('GET', '/api/v1/core/notifications/preferences', undefined, cookie);
		expect(again.body.prefs.quietHours).toEqual(quiet);
		const invalid = await call(
			'POST',
			'/api/v1/actions/core.setNotificationPreferences',
			{ kinds: {}, quietHours: { start: '25:00', end: '07:00' } },
			cookie,
		);
		expect(invalid.status).toBe(400);
	});
});

describe('family displays', () => {
	/** Pairs a display the way the app does; returns the display's device cookie. */
	async function pairDisplay(
		adminCookie: string,
		grant: { capabilities?: string[]; showNames?: boolean; name?: string } = {},
	) {
		const start = await call('POST', '/api/v1/core/displays/pair');
		expect(start.status).toBe(201);
		const confirm = await call(
			'POST',
			'/api/v1/actions/core.confirmDisplayPairing',
			{
				userCode: start.body.userCode,
				name: grant.name ?? 'Hallway',
				capabilities: grant.capabilities ?? ['calendar.view', 'lists.view'],
				showNames: grant.showNames ?? false,
			},
			adminCookie,
		);
		expect(confirm.status).toBe(200);
		const poll = await call('POST', '/api/v1/core/displays/pair/poll', {
			deviceCode: start.body.deviceCode,
		});
		expect(poll.body.status).toBe('paired');
		expect(poll.cookie).toMatch(/^famos_device=/);
		return {
			start,
			poll,
			pairingId: confirm.body.output.pairingId as string,
			displayCookie: poll.cookie,
			deviceId: poll.body.device.id as string,
		};
	}

	it('tells the admin when the display has claimed the code, and only the admin', async () => {
		const { cookie } = await setupAndSignIn();
		// Confirmed, but no screen asks with this code: waiting, not connected.
		const start = await call('POST', '/api/v1/core/displays/pair');
		const confirm = await call(
			'POST',
			'/api/v1/actions/core.confirmDisplayPairing',
			{ userCode: start.body.userCode, name: 'Kitchen wall', capabilities: [], showNames: false },
			cookie,
		);
		const path = `/api/v1/core/displays/pairings/${confirm.body.output.pairingId}`;
		expect((await call('GET', path, undefined, cookie)).body).toEqual({
			status: 'waiting',
			answering: false,
		});
		expect((await call('GET', path)).status).toBe(401);

		const { pairingId, deviceId } = await pairDisplay(cookie);
		expect(
			(await call('GET', `/api/v1/core/displays/pairings/${pairingId}`, undefined, cookie)).body,
		).toEqual({ status: 'connected', deviceId });
	});

	it('pairs by code: the token is set once, the display reads only what it was granted', async () => {
		const { cookie } = await setupAndSignIn();
		const { start, displayCookie } = await pairDisplay(cookie, { capabilities: ['calendar.view'] });

		// The device code is single-use: a second poll gets nothing, in particular no cookie.
		const again = await call('POST', '/api/v1/core/displays/pair/poll', {
			deviceCode: start.body.deviceCode,
		});
		expect(again.body).toEqual({ status: 'expired' });
		expect(again.cookie).toBe('');

		const day = '/api/v1/calendar/occurrences?from=2026-01-01&to=2026-01-02';
		expect((await call('GET', day, undefined, displayCookie)).status).toBe(200);
		expect((await call('GET', '/api/v1/lists/tasks', undefined, displayCookie)).status).toBe(403);
		const me = await call('GET', '/api/v1/core/displays/me', undefined, displayCookie);
		expect(me.body).toMatchObject({
			name: 'Hallway',
			capabilities: ['calendar.view'],
			showNames: false,
			disabledExtensions: [],
		});
		// Not a person: no profile, no sign-in routes, no actions (not even a harmless one).
		expect((await call('GET', '/api/v1/core/me', undefined, displayCookie)).status).toBe(401);
		expect(
			(await call('POST', '/api/v1/actions/lists.addTask', { title: 'x' }, displayCookie)).status,
		).toBe(401);
		expect((await call('GET', '/api/v1/core/devices', undefined, displayCookie)).status).toBe(403);
		expect((await call('GET', '/api/v1/core/members', undefined, displayCookie)).status).toBe(403);
		// Anonymous callers do not get displays/me.
		expect((await call('GET', '/api/v1/core/displays/me')).status).toBe(401);
	});

	it("tells a display its own style, else the family's", async () => {
		const { cookie } = await setupAndSignIn();
		const { displayCookie, deviceId } = await pairDisplay(cookie);
		const style = async () =>
			(await call('GET', '/api/v1/core/displays/me', undefined, displayCookie)).body.style;
		const act = (id: string, body: unknown) => call('POST', `/api/v1/actions/${id}`, body, cookie);
		expect(await style()).toBe('broadsheet');
		expect((await act('core.setFamilyStyle', { style: 'lanes' })).status).toBe(200);
		expect(await style()).toBe('lanes');
		expect((await act('core.setDisplayStyle', { deviceId, style: 'wall' })).status).toBe(200);
		expect(await style()).toBe('wall');
		// Public routes see a display as nobody: its own look comes only from displays/me.
		expect(
			(await call('GET', '/api/v1/core/appearance', undefined, displayCookie)).body,
		).toMatchObject({ style: 'lanes' });
		// A display cannot choose for itself: it runs no actions.
		expect(
			(await call('POST', '/api/v1/actions/core.setMyStyle', { style: 'lanes' }, displayCookie))
				.status,
		).toBe(401);
	});

	it("tells a display the pages it shows between Today's turns; it cannot choose them", async () => {
		const { cookie } = await setupAndSignIn();
		const { displayCookie, deviceId } = await pairDisplay(cookie);
		const rotation = async () =>
			(await call('GET', '/api/v1/core/displays/me', undefined, displayCookie)).body.rotation;
		expect(await rotation()).toBeNull();
		const chosen = {
			pages: ['homeassistant.values'],
			todaySeconds: 60,
			pageSeconds: 20,
			backSeconds: 90,
		};
		const set = await call(
			'POST',
			'/api/v1/actions/core.setDisplayPages',
			{ deviceId, rotation: chosen },
			cookie,
		);
		expect(set.status).toBe(200);
		expect(await rotation()).toEqual(chosen);
		expect((await call('GET', '/api/v1/core/displays/pages', undefined, cookie)).body).toEqual({
			displays: { [deviceId]: chosen },
		});
		// The list is for people who manage devices; a display runs no actions.
		expect(
			(await call('GET', '/api/v1/core/displays/pages', undefined, displayCookie)).status,
		).toBe(403);
		expect(
			(
				await call(
					'POST',
					'/api/v1/actions/core.setDisplayPages',
					{ deviceId, rotation: null },
					displayCookie,
				)
			).status,
		).toBe(401);
		expect(await rotation()).toEqual(chosen);
	});

	it('tells the admin what a display had no room for; only the display itself may say it', async () => {
		const { cookie } = await setupAndSignIn();
		const { displayCookie, deviceId } = await pairDisplay(cookie);
		const fit = '/api/v1/core/displays/me/fit';
		const leftOut = async () =>
			(
				(await call('GET', '/api/v1/core/devices', undefined, cookie)).body as {
					id: string;
					display: { leftOut: string[] } | null;
				}[]
			).find((d) => d.id === deviceId)?.display?.leftOut;
		expect(await leftOut()).toEqual([]);

		const report = (ids: string, who?: string) =>
			call('GET', `${fit}?leftOut=${encodeURIComponent(ids)}`, undefined, who);
		const said = await report('homeassistant.values,family,family', displayCookie);
		expect(said.status).toBe(204);
		expect(await leftOut()).toEqual(['family', 'homeassistant.values']);

		// A member or a stranger changes nothing; empty and overlong ids are dropped.
		expect((await report('', cookie)).status).toBe(409);
		expect((await report('')).status).toBe(401);
		expect(await leftOut()).toEqual(['family', 'homeassistant.values']);
		expect((await report(` , ,${'x'.repeat(101)},family`, displayCookie)).status).toBe(204);
		expect(await leftOut()).toEqual(['family']);

		// Everything fits again: nothing to say.
		expect((await report('', displayCookie)).status).toBe(204);
		expect(await leftOut()).toEqual([]);
	});

	it('refuses to pair a browser the family uses', async () => {
		const { cookie } = await setupAndSignIn();
		const { deviceCookie } = await trustDevice(cookie);
		// A member's session would outrank the display cookie, and a trusted family device would lose
		// its cookie: no code for either, and displays/me says why.
		for (const browser of [cookie, deviceCookie]) {
			expect((await call('POST', '/api/v1/core/displays/pair', undefined, browser)).status).toBe(
				409,
			);
			expect((await call('GET', '/api/v1/core/displays/me', undefined, browser)).status).toBe(409);
		}
	});

	it('counts waiting suggestions for a display that may, and lists none', async () => {
		const { cookie } = await setupAndSignIn();
		const plain = await pairDisplay(cookie, { name: 'Plain' });
		const counting = await pairDisplay(cookie, {
			name: 'Counting',
			capabilities: ['core.drafts.waiting'],
		});
		const count = '/api/v1/core/drafts/waiting';
		expect((await call('GET', count, undefined, plain.displayCookie)).status).toBe(403);
		expect((await call('GET', count, undefined, counting.displayCookie)).body).toEqual({
			count: 0,
		});
		// The drafts themselves stay with people who may propose.
		expect(
			(await call('GET', '/api/v1/core/drafts', undefined, counting.displayCookie)).status,
		).toBe(403);
		expect((await call('GET', count)).status).toBe(401);
	});

	it('never opens the profile picker or PIN sign-in on a display', async () => {
		const { cookie } = await setupAndSignIn();
		const kid = await addChildWithPin(cookie);
		const { displayCookie } = await pairDisplay(cookie);
		expect((await call('GET', '/api/v1/core/profiles', undefined, displayCookie)).status).toBe(401);
		expect(
			(await call('GET', '/api/v1/core/devices/current', undefined, displayCookie)).body,
		).toEqual({ device: null });
		const pin = await call(
			'POST',
			'/api/auth/sign-in/pin',
			{ memberId: kid.id, pin: '2468' },
			displayCookie,
		);
		expect(pin.status).toBe(403);
		// Nor can the display's browser turn itself into a family device.
		expect(
			(await call('POST', '/api/v1/core/devices/trust', { name: 'Sneaky' }, displayCookie)).status,
		).toBe(401);
		const trust = await call(
			'POST',
			'/api/v1/core/devices/trust',
			{ name: 'Sneaky' },
			`${cookie}; ${displayCookie}`,
		);
		expect(trust.status).toBe(409);
	});

	it('shows member names only on displays paired with "show names", without roles or notes', async () => {
		const { cookie } = await setupAndSignIn();
		const quiet = await pairDisplay(cookie, { name: 'Quiet' });
		const loud = await pairDisplay(cookie, { name: 'Loud', showNames: true });
		expect((await call('GET', '/api/v1/core/members', undefined, quiet.displayCookie)).status).toBe(
			403,
		);
		const members = await call('GET', '/api/v1/core/members', undefined, loud.displayCookie);
		expect(members.status).toBe(200);
		expect(members.body[0]).toMatchObject({ displayName: 'Parent', roleId: '', about: null });
		expect((await call('GET', '/api/v1/core/roles', undefined, loud.displayCookie)).status).toBe(
			403,
		);
		expect(
			(await call('GET', '/api/v1/core/displays/me', undefined, loud.displayCookie)).body
				.capabilities,
		).toContain('core.members.view');
	});

	it('a revoked display stops on its next request; turning an extension off hides it', async () => {
		const { cookie } = await setupAndSignIn();
		const { displayCookie, deviceId } = await pairDisplay(cookie);
		const tasks = () => call('GET', '/api/v1/lists/tasks', undefined, displayCookie);
		expect((await tasks()).status).toBe(200);

		await call(
			'POST',
			'/api/v1/actions/core.setFeatureEnabled',
			{ extensionId: 'lists', enabled: false },
			cookie,
		);
		expect((await tasks()).body.error.code).toBe('feature_off');
		const me = await call('GET', '/api/v1/core/displays/me', undefined, displayCookie);
		expect(me.body.capabilities).toEqual(['calendar.view']);
		expect(me.body.disabledExtensions).toEqual(['lists']);
		await call(
			'POST',
			'/api/v1/actions/core.setFeatureEnabled',
			{ extensionId: 'lists', enabled: true },
			cookie,
		);
		expect((await tasks()).status).toBe(200);

		const listed = await call('GET', '/api/v1/core/devices', undefined, cookie);
		expect(listed.body.find((d: { id: string }) => d.id === deviceId)).toMatchObject({
			kind: 'kiosk',
			display: { capabilities: ['calendar.view', 'lists.view'], showNames: false },
		});
		const patched = await call(
			'POST',
			'/api/v1/actions/core.updateDisplay',
			{ deviceId, name: 'Kitchen', capabilities: ['calendar.view'] },
			cookie,
		);
		expect(patched.body.output).toMatchObject({
			name: 'Kitchen',
			display: { capabilities: ['calendar.view'] },
		});
		expect((await tasks()).status).toBe(403);

		expect(
			(await call('POST', '/api/v1/actions/core.revokeDevice', { deviceId }, cookie)).status,
		).toBe(200);
		expect((await tasks()).status).toBe(401);
		expect((await call('GET', '/api/v1/core/displays/me', undefined, displayCookie)).status).toBe(
			401,
		);
	});

	it('closes a display’s open WebSocket when its device is revoked or changed', async () => {
		const { cookie } = await setupAndSignIn();
		const hub = createRealtimeHub(
			runtime.kernel.bus,
			silentLogger,
			runtime.kernel.access,
			runtime.kernel.registry.events,
		);
		const open = (deviceId: string | null) => {
			const ws = { send: vi.fn(), close: vi.fn() } as unknown as WSContext;
			hub
				.events(
					deviceId
						? { kind: 'display', deviceId, capabilities: ['calendar.view'], showNames: false }
						: { kind: 'member', memberId: 'member_x' as MemberId, roleId: 'admin' },
				)
				.onOpen(undefined, ws);
			return ws;
		};
		const first = await pairDisplay(cookie, { name: 'First' });
		const second = await pairDisplay(cookie, { name: 'Second' });
		const firstSocket = open(first.deviceId);
		const secondSocket = open(second.deviceId);
		const memberSocket = open(null);

		await call(
			'POST',
			'/api/v1/actions/core.updateDisplay',
			{ deviceId: first.deviceId, name: 'Renamed', capabilities: ['calendar.view'] },
			cookie,
		);
		expect(firstSocket.close).toHaveBeenCalledTimes(1);
		expect(secondSocket.close).not.toHaveBeenCalled();
		expect(memberSocket.close).not.toHaveBeenCalled();

		// It reconnects; revoking ends the new socket too.
		const again = open(first.deviceId);
		await call('POST', '/api/v1/actions/core.revokeDevice', { deviceId: first.deviceId }, cookie);
		expect(again.close).toHaveBeenCalledTimes(1);
		expect(secondSocket.close).not.toHaveBeenCalled();
		expect(hub.size()).toBe(2);
	});

	it('delivers member-targeted events to that member’s sockets only', async () => {
		const { cookie } = await setupAndSignIn();
		const hub = createRealtimeHub(
			runtime.kernel.bus,
			silentLogger,
			runtime.kernel.access,
			runtime.kernel.registry.events,
		);
		const display = await pairDisplay(cookie, { name: 'Hall', capabilities: ['lists.view'] });
		const member = (memberId: string): Actor => ({
			kind: 'member',
			memberId: memberId as MemberId,
			roleId: 'member',
		});
		const open = (actor: Actor) => {
			const ws = { send: vi.fn(), close: vi.fn() } as unknown as WSContext;
			hub.events(actor).onOpen(undefined, ws);
			return ws;
		};
		const ayse = open(member('member_ayse'));
		const ayseSecond = open(member('member_ayse'));
		const can = open(member('member_can'));
		const hall = open({
			kind: 'display',
			deviceId: display.deviceId,
			capabilities: ['lists.view'],
			showNames: false,
		});
		const sent = (ws: WSContext) =>
			(ws.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(c[0] as string));

		await runtime.kernel.bus.publishTo('member_ayse', 'core.conversation.answered', {
			replyId: 'private',
		});
		expect(sent(ayse)).toContainEqual({
			type: 'event',
			name: 'core.conversation.answered',
			payload: { replyId: 'private' },
		});
		expect(sent(ayseSecond)).toHaveLength(2); // hello + the event
		expect(JSON.stringify(sent(can))).not.toContain('private');
		expect(JSON.stringify(sent(hall))).not.toContain('private');

		// Ordinary events reach those in their audience; targeted ones are not seen by `onAny` listeners.
		const seen: string[] = [];
		runtime.kernel.bus.onAny((name) => void seen.push(name));
		await runtime.kernel.bus.publishTo('member_ayse', 'core.conversation.answered', {
			replyId: 'again',
		});
		expect(seen).toEqual([]);
		await runtime.kernel.bus.publish('lists.task.changed', { taskId: 't' });
		expect(sent(can).some((m) => m.name === 'lists.task.changed')).toBe(true);
		expect(sent(hall).some((m) => m.name === 'lists.task.changed')).toBe(true);
	});

	it('gives displays photos and weather only when granted, and nothing when the extension is off', async () => {
		const { cookie } = await setupAndSignIn();
		const plain = await pairDisplay(cookie, { name: 'Plain', capabilities: ['calendar.view'] });
		const weather = await pairDisplay(cookie, {
			name: 'Weather',
			capabilities: ['ambient.weather'],
		});
		const photos = await pairDisplay(cookie, { name: 'Photos', capabilities: ['ambient.photos'] });
		const get = (path: string, c: string) => call('GET', `/api/v1/ambient${path}`, undefined, c);

		expect((await get('/weather', plain.displayCookie)).status).toBe(403);
		expect((await get('/photos', plain.displayCookie)).status).toBe(403);
		expect((await get('/photos', weather.displayCookie)).status).toBe(403);
		expect((await get('/weather', photos.displayCookie)).status).toBe(403);
		// Settings, the photo library and place search are for people who manage display content.
		for (const path of ['/settings', '/library', '/places?q=ab'])
			expect((await get(path, photos.displayCookie)).status).toBe(403);
		expect((await get('/settings', cookie)).status).toBe(200);

		// Nothing is set up: weather is off, the photo list is empty, and nothing leaves the server.
		expect((await get('/weather', weather.displayCookie)).body).toMatchObject({
			enabled: false,
			forecast: null,
		});
		expect((await get('/photos', photos.displayCookie)).body).toMatchObject({ ids: [] });
		// Today's photo: the same capability, and nothing yet (not read as a photo id).
		expect((await get('/photos/today', plain.displayCookie)).status).toBe(403);
		expect((await get('/photos/today', photos.displayCookie)).body).toEqual({ photo: null });
		expect((await get('/photos/today', cookie)).body).toEqual({ photo: null });
		expect(
			(await get('/photos/amb_photo_00000000-0000-7000-8000-000000000001', photos.displayCookie))
				.status,
		).toBe(404);

		await call(
			'POST',
			'/api/v1/actions/core.setFeatureEnabled',
			{ extensionId: 'ambient', enabled: false },
			cookie,
		);
		const off = await get('/photos', photos.displayCookie);
		expect(off.body.error.code).toBe('feature_off');
		expect((await get('/weather', weather.displayCookie)).body.error.code).toBe('feature_off');
	});

	it('lets a signed-in member win on the same browser, and only admins pair or edit', async () => {
		const { cookie } = await setupAndSignIn();
		const { displayCookie, deviceId } = await pairDisplay(cookie, {
			capabilities: ['calendar.view'],
		});
		const both = `${cookie}; ${displayCookie}`;
		expect((await call('GET', '/api/v1/core/me', undefined, both)).status).toBe(200);
		expect((await call('GET', '/api/v1/lists/tasks', undefined, both)).status).toBe(200);

		await addChildWithPin(cookie);
		const { deviceCookie } = await trustDevice(cookie);
		const kid = (await call('GET', '/api/v1/core/profiles', undefined, deviceCookie)).body[0];
		const kidSession = (
			await call('POST', '/api/auth/sign-in/pin', { memberId: kid.id, pin: '2468' }, deviceCookie)
		).cookie;
		const start = await call('POST', '/api/v1/core/displays/pair');
		const grant = { userCode: start.body.userCode, name: 'X', capabilities: [], showNames: false };
		expect((await call('POST', '/api/v1/actions/core.confirmDisplayPairing', grant)).status).toBe(
			401,
		);
		expect(
			(await call('POST', '/api/v1/actions/core.confirmDisplayPairing', grant, kidSession)).status,
		).toBe(403);
		expect(
			(await call('POST', '/api/v1/actions/core.confirmDisplayPairing', grant, displayCookie))
				.status,
		).toBe(401);
		expect(
			(
				await call(
					'POST',
					'/api/v1/actions/core.updateDisplay',
					{ deviceId, name: 'Mine' },
					kidSession,
				)
			).status,
		).toBe(403);
		expect(
			(await call('GET', '/api/v1/core/displays/capabilities', undefined, kidSession)).status,
		).toBe(403);
		expect((await call('GET', '/api/v1/core/devices/address', undefined, kidSession)).status).toBe(
			403,
		);
		expect(
			(await call('GET', '/api/v1/core/devices/address', undefined, displayCookie)).status,
		).toBe(401);
		expect((await call('GET', '/api/v1/core/devices/address', undefined, cookie)).body).toEqual({
			url: 'https://famos.example',
		});
		const caps = await call('GET', '/api/v1/core/displays/capabilities', undefined, cookie);
		expect(caps.body.map((c: { id: string }) => c.id)).toEqual(
			expect.arrayContaining(['calendar.view', 'lists.view', 'core.drafts.waiting']),
		);
		expect(caps.body.map((c: { id: string }) => c.id)).not.toContain('calendar.edit');
	});

	it('rate-limits starting a pairing per address and tells fast pollers to slow down', async () => {
		const fromOneAddress = (path: string, body?: unknown) =>
			app.request(`${BASE}${path}`, {
				method: 'POST',
				headers: {
					origin: BASE,
					'content-type': 'application/json',
					'x-forwarded-for': '10.9.9.9',
				},
				...(body !== undefined && { body: JSON.stringify(body) }),
			});
		let first: { deviceCode: string } | undefined;
		// An address may hold three codes open at once; a fourth waits until one is used or expires.
		for (let i = 0; i < 3; i++) {
			const res = await fromOneAddress('/api/v1/core/displays/pair');
			expect(res.status).toBe(201);
			first ??= (await res.json()) as { deviceCode: string };
		}
		expect((await fromOneAddress('/api/v1/core/displays/pair')).status).toBe(429);
		// Another address is unaffected.
		expect((await call('POST', '/api/v1/core/displays/pair')).status).toBe(201);

		const poll = async () =>
			(await (
				await fromOneAddress('/api/v1/core/displays/pair/poll', { deviceCode: first?.deviceCode })
			).json()) as {
				status: string;
			};
		expect((await poll()).status).toBe('pending');
		expect((await poll()).status).toBe('slow_down');
	});

	it('makes actions safe to repeat with an Idempotency-Key header', async () => {
		const { cookie } = await setupAndSignIn();
		const create = (name: string, key?: string) =>
			call(
				'POST',
				'/api/v1/actions/core.createMember',
				{ displayName: name, roleId: 'member' },
				cookie,
				key ? { 'idempotency-key': key } : {},
			);
		const first = await create('Ayla', 'tap_1');
		expect(first.status).toBe(200);
		expect(first.headers.get('idempotent-replayed')).toBeNull();
		const second = await create('Ayla', 'tap_1');
		expect(second.status).toBe(200);
		expect(second.headers.get('idempotent-replayed')).toBe('true');
		expect(second.body).toEqual(first.body);
		const members = await call('GET', '/api/v1/core/members', undefined, cookie);
		expect(
			members.body.filter((m: { displayName: string }) => m.displayName === 'Ayla'),
		).toHaveLength(1);

		// Another action with the same key, and a malformed key.
		const mismatch = await call(
			'POST',
			'/api/v1/actions/core.updateFamilySettings',
			{ timeZone: 'Europe/Istanbul' },
			cookie,
			{ 'idempotency-key': 'tap_1' },
		);
		expect(mismatch.status).toBe(422);
		expect(mismatch.body.error.code).toBe('idempotency_mismatch');
		expect((await create('Bora', 'has spaces!')).status).toBe(400);
		// Without a key nothing is remembered.
		expect((await create('Cem')).headers.get('idempotent-replayed')).toBeNull();
	});
});

describe('asking what you may do', () => {
	async function signInKid() {
		const { cookie } = await setupAndSignIn();
		const kid = await addChildWithPin(cookie);
		const { deviceCookie } = await trustDevice(cookie);
		const session = (
			await call('POST', '/api/auth/sign-in/pin', { memberId: kid.id, pin: '2468' }, deviceCookie)
		).cookie;
		return { adminCookie: cookie, kidCookie: session };
	}
	const newMember = { displayName: 'Pat', roleId: 'member' };

	it('answers every action for the viewer, and one input exactly, without running it', async () => {
		const { kidCookie } = await signInKid();
		const access = await call('GET', '/api/v1/core/access', undefined, kidCookie);
		expect(access.status).toBe(200);
		expect(access.body.actions['core.createMember']).toEqual({
			outcome: 'refuse',
			reason: 'capability',
			capability: 'core.members.manage',
		});
		expect(access.body.actions['lists.addShoppingItems']).toEqual({ outcome: 'apply' });
		expect(access.body.actions['lists.deleteShoppingItem']).toMatchObject({ depends: true });

		const check = (actionId: string, input: unknown) =>
			call('POST', `/api/v1/actions/${actionId}/check`, { input }, kidCookie);
		expect((await check('core.createMember', newMember)).body).toEqual({
			outcome: 'refuse',
			reason: 'capability',
			capability: 'core.members.manage',
		});
		expect((await check('core.nothing', {})).status).toBe(404);
		expect((await check('lists.addShoppingItems', { items: 'oops' })).status).toBe(400);
		expect((await call('GET', '/api/v1/core/members', undefined, kidCookie)).body).toHaveLength(2);
	});

	it('needs a sign-in, and limits how often one person asks', async () => {
		expect((await call('GET', '/api/v1/core/access')).status).toBe(401);
		expect(
			(await call('POST', '/api/v1/actions/core.createMember/check', { input: newMember })).status,
		).toBe(401);
		const { kidCookie } = await signInKid();
		const ask = () =>
			call('POST', '/api/v1/actions/core.createMember/check', { input: newMember }, kidCookie);
		let status = 200;
		for (let i = 0; i < 241 && status === 200; i++) status = (await ask()).status;
		expect(status).toBe(429);
	});

	it('says why a call was refused, without naming the action', async () => {
		const { kidCookie } = await signInKid();
		const refused = await call('POST', '/api/v1/actions/core.createMember', newMember, kidCookie);
		expect(refused.status).toBe(403);
		expect(refused.body.error).toMatchObject({
			code: 'forbidden',
			reason: 'capability',
			capability: 'core.members.manage',
		});
		expect(refused.body.error.message).not.toMatch(/core\./);
		const route = await call('GET', '/api/v1/core/devices', undefined, kidCookie);
		expect(route.status).toBe(403);
		expect(route.body.error).toMatchObject({ reason: 'capability' });
	});
});
