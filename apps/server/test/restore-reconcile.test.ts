import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import type { CoreTables } from '@famos/core';
import type { MemberId } from '@famos/sdk';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { restoreFile } from '../src/restore.ts';
import { finishRestore } from '../src/restore-pending.ts';
import { backupNow, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const BASE = 'http://localhost:3000';
const SECRET = 'a-test-secret-of-more-than-32-characters';
const PASSWORD = 'correct horse battery';
const OLD = 'the password before the leak';
const NEW = 'the password after the leak';

let runtime: Runtime | undefined;
let app: ReturnType<typeof createHttpApp>;
let ip = 0;

const open = (config: Config) => {
	const r = openRuntime(config, {
		extensions,
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
	});
	app = createHttpApp({
		kernel: r.kernel,
		ai: r.ai,
		webPush: r.webPush,
		telegram: r.telegram,
		email: r.email,
		backups: r.backups,
		backupsDir: r.config.backupsDir,
		backupSchedule: r.config.backup,
		identity: r.identity,
		knownDevices: r.knownDevices,
		logger: silentLogger,
		trustedOrigins: [BASE],
		appVersion: '0.0.0-test',
		secureCookies: false,
		trustedProxies: ['127.0.0.1'],
	});
	return r;
};

/** Starts the server the way `serve` does: migrate, start, then the step after a restore. */
async function boot(config: Config) {
	runtime = open(config);
	await migrate(runtime);
	await runtime.kernel.start();
	await finishRestore(runtime);
	return runtime;
}

afterEach(async () => {
	await runtime?.close();
	runtime = undefined;
});

async function call(method: string, path: string, body?: unknown, cookie?: string) {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			'x-forwarded-for': `10.7.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`,
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

const signIn = (email: string, password: string) =>
	call('POST', '/api/auth/sign-in/email', { email, password });

const actorOf = (id: string, roleId: string) => ({
	kind: 'member' as const,
	memberId: id as MemberId,
	roleId,
});

const mcpStatus = async (secret: string) =>
	(
		await app.request(`${BASE}/mcp`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'x-forwarded-for': `10.8.0.${++ip % 250}`,
				authorization: `Bearer ${secret}`,
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		})
	).status;

async function newConfig() {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-restore-reconcile-'));
	return loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE, FAMOS_SECRET: SECRET });
}

describe('a restore does not bring back what the family ended after the backup', () => {
	it('keeps revoked keys, devices, addresses, archived members and new passwords, and signs everyone out', async () => {
		const config = await newConfig();
		const r = await boot(config);
		const setup = await call('POST', '/api/v1/core/setup', {
			displayName: 'Parent',
			email: 'parent@example.com',
			password: PASSWORD,
			locale: 'en',
			setupCode: r.config.setupCode,
		});
		expect(setup.status).toBe(201);
		const adminId = setup.body.id as string;
		const admin = (await signIn('parent@example.com', PASSWORD)).cookie;
		const admin2 = actorOf(adminId, 'admin');
		expect((await call('PUT', '/api/v1/mcp/settings', { enabled: true }, admin)).status).toBe(200);

		const member = async (displayName: string, email: string, password: string) => {
			const made = await call(
				'POST',
				'/api/v1/actions/core.createMember',
				{ displayName, roleId: 'member' },
				admin,
			);
			const id = made.body.output.id as string;
			expect(
				(await call('PUT', `/api/v1/core/members/${id}/password`, { email, password }, admin))
					.status,
			).toBe(200);
			return id;
		};
		const kid = await member('Kid', 'kid@example.com', PASSWORD);
		const mom = await member('Mom', 'mom@example.com', OLD);
		const kidCookie = (await signIn('kid@example.com', PASSWORD)).cookie;
		expect((await call('GET', '/api/v1/core/me', undefined, kidCookie)).status).toBe(200);

		// Made before the backup: two keys, two devices, two calendar addresses.
		const key = async (name: string) =>
			(await r.kernel.apiTokens.create(admin2, { name, scope: 'read' })).secret;
		const revokedKey = await key('Will be revoked');
		const keptKey = await key('Stays');
		const device = (name: string) => r.kernel.devices.trust(admin2, { name });
		const revokedDevice = await device('Old tablet');
		const keptDevice = await device('Kitchen');
		const feed = async () => {
			const made = await call(
				'POST',
				'/api/v1/actions/calendar.createFeed',
				{ scope: 'family' },
				admin,
			);
			expect(made.body.status).toBe('applied');
			return { id: made.body.output.feed.id as string, path: made.body.output.path as string };
		};
		const revokedFeed = await feed();
		const keptFeed = await feed();
		expect(await mcpStatus(revokedKey)).toBe(200);
		expect((await call('GET', revokedFeed.path)).status).toBe(200);

		// Two Telegram chats linked before the backup.
		for (const [memberId, userId] of [
			[mom, 11],
			[adminId, 12],
		] as const)
			await sql`insert into telegram_links (member_id, telegram_user_id, chat_id, linked_at)
				values (${memberId}, ${userId}, ${userId}, 1)`.execute(r.handle.db);

		const { path: backup } = await backupNow(r, 'manual');

		// After the backup: the family ends and changes things.
		const listed = await r.kernel.apiTokens.list(admin2);
		const revokedKeyId = listed.find((t) => t.name === 'Will be revoked')?.id as string;
		await r.kernel.apiTokens.revoke(admin2, revokedKeyId);
		expect(
			(await call('DELETE', `/api/v1/core/devices/${revokedDevice.device.id}`, undefined, admin))
				.status,
		).toBe(200);
		expect(
			(await call('POST', '/api/v1/actions/core.archiveMember', { memberId: kid }, admin)).body
				.status,
		).toBe('applied');
		expect(
			(
				await call(
					'PUT',
					`/api/v1/core/members/${mom}/password`,
					{ email: 'mom@example.com', password: NEW },
					admin,
				)
			).status,
		).toBe(200);
		expect(
			(await call('POST', '/api/v1/actions/calendar.revokeFeed', { id: revokedFeed.id }, admin))
				.body.status,
		).toBe('applied');
		await r.telegram.unlink(mom);
		await r.kernel.worker.drain();
		expect(await mcpStatus(revokedKey)).toBe(401);
		expect((await call('GET', revokedFeed.path)).status).toBe(404);

		await r.close();
		runtime = undefined;
		await restoreFile(config, backup, { extensions });
		const restored = await boot(config);
		await restored.kernel.worker.drain();

		// Revoked things stay revoked; what was not revoked works as before.
		expect(await mcpStatus(revokedKey)).toBe(401);
		expect(await mcpStatus(keptKey)).toBe(200);
		expect((await call('GET', revokedFeed.path)).status).toBe(404);
		expect((await call('GET', keptFeed.path)).status).toBe(200);
		expect(await restored.kernel.devices.verify(revokedDevice.token)).toBeNull();
		expect(await restored.kernel.devices.verify(keptDevice.token)).not.toBeNull();
		const members = await restored.kernel.ctx.family.members();
		expect(members.map((m) => m.displayName).sort()).toEqual(['Mom', 'Parent']);

		// The chat unlinked since the backup stays unlinked; the other is still linked.
		const links = await sql<{ member_id: string }>`select member_id from telegram_links`.execute(
			restored.handle.db,
		);
		expect(links.rows.map((l) => l.member_id)).toEqual([adminId]);

		// The new password works, the old one does not; the member archived since cannot sign in.
		expect((await signIn('mom@example.com', NEW)).status).toBe(200);
		expect((await signIn('mom@example.com', OLD)).status).not.toBe(200);
		expect((await signIn('kid@example.com', PASSWORD)).status).not.toBe(200);

		// Everyone signs in again: the sessions from before the restore are gone.
		expect((await call('GET', '/api/v1/core/me', undefined, admin)).status).toBe(401);
		expect((await call('GET', '/api/v1/core/me', undefined, kidCookie)).status).toBe(401);
		expect((await signIn('parent@example.com', PASSWORD)).status).toBe(200);

		// Admins are told what was kept, and the marker is spent.
		const notices = await restored.kernel.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_notifications')
			.select('kind')
			.where('kind', '=', 'core.backupRestored')
			.execute();
		expect(notices.length).toBeGreaterThan(0);
		expect((await readdir(config.dataDir)).includes('restore-pending.json')).toBe(false);
		// The moved-aside database keeps its journal beside it.
		expect((await readdir(config.dataDir)).some((n) => n.startsWith('famos.db.pre-restore-'))).toBe(
			true,
		);
	});

	it('a restore onto a new server, with nothing set aside, only signs everyone out', async () => {
		const source = await newConfig();
		const r = await boot(source);
		const setup = await call('POST', '/api/v1/core/setup', {
			displayName: 'Parent',
			email: 'parent@example.com',
			password: PASSWORD,
			locale: 'en',
			setupCode: r.config.setupCode,
		});
		const adminId = setup.body.id as string;
		const cookie = (await signIn('parent@example.com', PASSWORD)).cookie;
		await call('PUT', '/api/v1/mcp/settings', { enabled: true }, cookie);
		const { secret } = await r.kernel.apiTokens.create(actorOf(adminId, 'admin'), {
			name: 'Laptop',
			scope: 'read',
		});
		const { path: backup } = await backupNow(r, 'manual');
		await r.close();
		runtime = undefined;

		const target = await newConfig();
		await restoreFile(target, backup, { extensions });
		const restored = await boot(target);
		await restored.kernel.worker.drain();

		expect((await call('GET', '/api/v1/core/me', undefined, cookie)).status).toBe(401);
		expect((await signIn('parent@example.com', PASSWORD)).status).toBe(200);
		// Keys were not touched: nothing says they were ended.
		expect(await mcpStatus(secret)).toBe(200);
		expect((await readdir(target.dataDir)).includes('restore-pending.json')).toBe(false);
	});
});
