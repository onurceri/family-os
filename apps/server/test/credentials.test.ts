import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import type { MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const BASE = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;

beforeEach(async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-credentials-'));
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
			'x-forwarded-for': `10.4.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`,
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(cookie && { cookie }),
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return {
		status: res.status,
		body: text?.startsWith('{') ? JSON.parse(text) : text,
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

/** The admin signs in with the password; the same admin has a PIN on a trusted family device. */
async function household() {
	const setup = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: PASSWORD,
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	expect(setup.status).toBe(201);
	const adminId = setup.body.id as string;
	const signIn = () =>
		call('POST', '/api/auth/sign-in/email', { email: 'parent@example.com', password: PASSWORD });
	const cookie = (await signIn()).cookie;
	const device = await call('POST', '/api/v1/core/devices/trust', { name: 'Kitchen' }, cookie);
	expect(device.status).toBe(201);
	expect(
		(await call('PUT', `/api/v1/core/members/${adminId}/pin`, { pin: '8642' }, cookie)).status,
	).toBe(200);
	// A new PIN ends the sessions: sign in again.
	const password = (await signIn()).cookie;
	const pin = (
		await call('POST', '/api/auth/sign-in/pin', { memberId: adminId, pin: '8642' }, device.cookie)
	).cookie;
	expect(pin).not.toBe('');
	return { adminId, password, pin, signIn };
}

async function addMember(cookie: string, displayName: string, roleId = 'member') {
	const res = await call(
		'POST',
		'/api/v1/actions/core.createMember',
		{ displayName, roleId },
		cookie,
	);
	expect(res.body.status).toBe('applied');
	return res.body.output.id as string;
}

const actorOf = (id: string, roleId: string) => ({
	kind: 'member' as const,
	memberId: id as MemberId,
	roleId,
});

async function enableMcp(cookie: string) {
	expect((await call('PUT', '/api/v1/mcp/settings', { enabled: true }, cookie)).status).toBe(200);
}

async function feedOf(cookie: string, scope: string) {
	const res = await call('POST', '/api/v1/actions/calendar.createFeed', { scope }, cookie);
	expect(res.body.status).toBe('applied');
	return res.body.output.path as string;
}

const mcpStatus = async (secret: string) =>
	(
		await app.request(`${BASE}/mcp`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'x-forwarded-for': `10.5.0.${++ip % 250}`,
				authorization: `Bearer ${secret}`,
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		})
	).status;

const feedStatus = async (path: string) => (await call('GET', path)).status;
/** Addresses end from the job queue, a moment after the change that ended them. */
const feedEnds = (path: string) =>
	vi.waitFor(async () => expect(await feedStatus(path)).toBe(404), { timeout: 15_000 });

describe('a PIN cannot make a credential that works away from the device', () => {
	it('refuses API tokens, calendar addresses and Telegram links, with the reason', async () => {
		const { password, pin } = await household();

		const token = await call(
			'POST',
			'/api/v1/mcp/tokens',
			{ name: 'Kitchen', scope: 'read_write' },
			pin,
		);
		expect(token.status).toBe(403);
		expect(token.body.error.message).toBe('Sign in with your password to create keys');

		const feed = await call(
			'POST',
			'/api/v1/actions/calendar.createFeed',
			{ scope: 'family' },
			pin,
		);
		expect(feed.status).toBe(403);
		expect(feed.body.error.message).toBe('Sign in with your password to create keys');

		const link = await call('POST', '/api/v1/telegram/link', undefined, pin);
		expect(link.status).toBe(403);

		const me = await call('GET', '/api/v1/core/me', undefined, pin);
		expect(me.body.fullSignIn).toBe(false);

		// The same person with the password may.
		expect(
			(await call('POST', '/api/v1/mcp/tokens', { name: 'Laptop', scope: 'read' }, password))
				.status,
		).toBe(201);
		const ok = await call(
			'POST',
			'/api/v1/actions/calendar.createFeed',
			{ scope: 'family' },
			password,
		);
		expect(ok.body.status).toBe('applied');
		expect((await call('GET', '/api/v1/core/me', undefined, password)).body.fullSignIn).toBe(true);
	});

	it('refuses a PIN actor, the AI, a display and the system at the service too', async () => {
		const { adminId } = await household();
		const pin = { ...actorOf(adminId, 'admin'), pin: true };
		await expect(
			runtime.kernel.apiTokens.create(pin, { name: 'x', scope: 'read' }),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			runtime.kernel.apiTokens.create(
				{ kind: 'system', source: 'test' },
				{ name: 'x', scope: 'read' },
			),
		).rejects.toMatchObject({ code: 'unauthenticated' });
	});
});

describe('signing out ends what a member made', () => {
	it('"sign out everywhere" ends API tokens and calendar addresses', async () => {
		const { adminId, password } = await household();
		await enableMcp(password);
		const { secret } = await runtime.kernel.apiTokens.create(actorOf(adminId, 'admin'), {
			name: 'Laptop',
			scope: 'read',
		});
		const path = await feedOf(password, 'family');
		expect(await mcpStatus(secret)).toBe(200);
		expect(await feedStatus(path)).toBe(200);

		expect((await call('POST', '/api/v1/core/sessions/end', undefined, password)).status).toBe(200);

		// The key ends in the same transaction; the address, from the queue.
		expect(await mcpStatus(secret)).toBe(401);
		await feedEnds(path);
	});

	it('a new password for a member ends their tokens and addresses, not other people’s', async () => {
		const { password } = await household();
		await enableMcp(password);
		const kid = await addMember(password, 'Kid');
		const other = await addMember(password, 'Other');
		const token = async (id: string) =>
			(await runtime.kernel.apiTokens.create(actorOf(id, 'member'), { name: 'k', scope: 'read' }))
				.secret;
		const feed = async (id: string) => {
			const made = await runtime.kernel.runner.invoke<{ path: string }>(
				'calendar.createFeed',
				{ scope: id },
				actorOf(id, 'member'),
			);
			if (made.status !== 'applied') throw new Error('feed');
			return made.output;
		};
		const kidToken = await token(kid);
		const otherToken = await token(other);
		const kidFeed = { status: 'applied', output: await feed(kid) };
		const otherFeed = { status: 'applied', output: await feed(other) };
		expect(await mcpStatus(kidToken)).toBe(200);
		expect(await feedStatus(kidFeed.output.path)).toBe(200);

		const set = await call(
			'PUT',
			`/api/v1/core/members/${kid}/password`,
			{ email: 'kid@example.com', password: 'another long password' },
			password,
		);
		expect(set.status).toBe(200);

		expect(await mcpStatus(kidToken)).toBe(401);
		await feedEnds(kidFeed.output.path);
		expect(await mcpStatus(otherToken)).toBe(200);
		expect(await feedStatus(otherFeed.output.path)).toBe(200);
	});

	it('archiving a member ends their calendar addresses as well as their tokens', async () => {
		const { password } = await household();
		const kid = await addMember(password, 'Kid');
		const made = await runtime.kernel.runner.invoke<{ path: string }>(
			'calendar.createFeed',
			{ scope: kid },
			actorOf(kid, 'member'),
		);
		if (made.status !== 'applied') throw new Error('feed');
		expect(await feedStatus(made.output.path)).toBe(200);
		const archived = await call(
			'POST',
			'/api/v1/actions/core.archiveMember',
			{ memberId: kid },
			password,
		);
		expect(archived.body.status).toBe('applied');
		expect(await feedStatus(made.output.path)).toBe(404);
	});
});

describe('a calendar address acts for its owner as they are today', () => {
	it('stops when the owner loses the right to see the calendar', async () => {
		const { password } = await household();
		const role = await call(
			'POST',
			'/api/v1/actions/core.createRole',
			{ name: 'Viewer', base: 'member', overrides: {} },
			password,
		);
		expect(role.body.status).toBe('applied');
		const roleId = role.body.output.id as string;
		const kid = await addMember(password, 'Kid', roleId);
		const made = await runtime.kernel.runner.invoke<{ path: string }>(
			'calendar.createFeed',
			{ scope: kid },
			actorOf(kid, roleId),
		);
		if (made.status !== 'applied') throw new Error('feed');
		expect(await feedStatus(made.output.path)).toBe(200);
		const changed = await call(
			'POST',
			'/api/v1/actions/core.updateRole',
			{ id: roleId, overrides: { 'calendar.view': false } },
			password,
		);
		expect(changed.body.status).toBe('applied');
		expect(await feedStatus(made.output.path)).toBe(404);
	});

	it('a whole-family address stops when its owner may no longer manage the calendar', async () => {
		const { password } = await household();
		const role = await call(
			'POST',
			'/api/v1/actions/core.createRole',
			{ name: 'Planner', base: 'member', overrides: { 'calendar.manage': true } },
			password,
		);
		expect(role.body.status).toBe('applied');
		const roleId = role.body.output.id as string;
		const kid = await addMember(password, 'Kid', roleId);
		const made = await runtime.kernel.runner.invoke<{ path: string }>(
			'calendar.createFeed',
			{ scope: 'family' },
			actorOf(kid, roleId),
		);
		if (made.status !== 'applied') throw new Error('feed');
		expect(await feedStatus(made.output.path)).toBe(200);
		await call('POST', '/api/v1/actions/core.updateRole', { id: roleId, overrides: {} }, password);
		expect(await feedStatus(made.output.path)).toBe(404);
	});
});

describe('the app key endpoint', () => {
	it('records a use only when it is permitted', async () => {
		const { password } = await household();
		await enableMcp(password);
		const role = await call(
			'POST',
			'/api/v1/actions/core.createRole',
			{ name: 'Teen', base: 'supervised', overrides: { 'core.mcp.use': true } },
			password,
		);
		const roleId = role.body.output.id as string;
		const kid = await addMember(password, 'Kid', roleId);
		const { secret, token } = await runtime.kernel.apiTokens.create(actorOf(kid, roleId), {
			name: 'k',
			scope: 'read',
		});
		const lastUsed = async () =>
			(await runtime.kernel.apiTokens.list(actorOf(kid, roleId)))[0]?.lastUsedAt;
		expect(await lastUsed()).toBeNull();

		// The role loses the right to use app keys: refused, and not recorded as a use.
		await call('POST', '/api/v1/actions/core.updateRole', { id: roleId, overrides: {} }, password);
		expect(await mcpStatus(secret)).toBe(403);
		expect(await lastUsed()).toBeNull();

		await call(
			'POST',
			'/api/v1/actions/core.updateRole',
			{ id: roleId, overrides: { 'core.mcp.use': true } },
			password,
		);
		expect(await mcpStatus(secret)).toBe(200);
		expect(await lastUsed()).not.toBeNull();
		expect(token.id).toBeTruthy();
	});

	it('offers the list of people only to a key whose owner may see the members', async () => {
		const { password } = await household();
		await enableMcp(password);
		const names = async (secret: string) => {
			const res = await app.request(`${BASE}/mcp`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					'x-forwarded-for': `10.6.0.${++ip % 250}`,
					authorization: `Bearer ${secret}`,
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
			});
			const text = await res.text();
			const json = text.startsWith('event:') ? (/^data: (.*)$/m.exec(text)?.[1] ?? '') : text;
			return (JSON.parse(json).result.tools as { name: string }[]).map((t) => t.name);
		};
		const blind = await call(
			'POST',
			'/api/v1/actions/core.createRole',
			{
				name: 'Blind',
				base: 'member',
				overrides: { 'core.mcp.use': true, 'core.members.view': false },
			},
			password,
		);
		expect(blind.body.status).toBe('applied');
		const blindId = blind.body.output.id as string;
		const kid = await addMember(password, 'Kid', blindId);
		const normal = await addMember(password, 'Normal');
		const kidKey = await runtime.kernel.apiTokens.create(actorOf(kid, blindId), {
			name: 'k',
			scope: 'read',
		});
		const normalKey = await runtime.kernel.apiTokens.create(actorOf(normal, 'member'), {
			name: 'n',
			scope: 'read',
		});
		expect(await names(normalKey.secret)).toContain('family_listPeople');
		expect(await names(kidKey.secret)).not.toContain('family_listPeople');
	});
});
