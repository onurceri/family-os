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
		expect(
			(await call('POST', '/api/v1/actions/core.setMcpEnabled', { enabled: true }, admin)).status,
		).toBe(200);

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
			(
				await call(
					'POST',
					'/api/v1/actions/core.revokeDevice',
					{ deviceId: revokedDevice.device.id },
					admin,
				)
			).body.status,
		).toBe('applied');
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
		await call('POST', '/api/v1/actions/core.setMcpEnabled', { enabled: true }, cookie);
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

	it('keeps demotions, archives and narrowed roles made after the backup, and loses promotions and widenings', async () => {
		const config = await newConfig();
		const r = await boot(config);
		const setup = await call('POST', '/api/v1/core/setup', {
			displayName: 'Parent',
			email: 'parent@example.com',
			password: PASSWORD,
			locale: 'en',
			setupCode: r.config.setupCode,
		});
		const adminId = setup.body.id as string;
		const admin = (await signIn('parent@example.com', PASSWORD)).cookie;
		const run = async (action: string, input: unknown) => {
			const done = await call('POST', `/api/v1/actions/${action}`, input, admin);
			expect(done.body.status).toBe('applied');
			return done.body.output;
		};
		const person = async (displayName: string, roleId: string) =>
			(await run('core.createMember', { displayName, roleId })).id as string;
		const role = async (name: string, overrides: Record<string, boolean>) =>
			(await run('core.createRole', { name, base: 'member', overrides })).id as string;

		const narrowed = await role('Helper', {});
		const widened = await role('Limited', { 'core.drafts.propose': false });
		const demoted = await person('Demoted', 'member');
		const archived = await person('Archived', 'member');
		const promoted = await person('Promoted', 'supervised');
		const helper = await person('Helper holder', narrowed);
		const limited = await person('Limited holder', widened);
		const untouched = await person('Untouched', 'member');
		// Two roles that each lack something the other has; a third that lacks both exists for the
		// first pair only.
		const noPropose = await role('No suggestions', { 'core.drafts.propose': false });
		const noReceive = await role('No notices', { 'core.notifications.receive': false });
		const neither = await role('Neither', {
			'core.drafts.propose': false,
			'core.notifications.receive': false,
		});
		const noMemory = await role('No memory', { 'core.memory.use': false });
		const noWaiting = await role('No waiting', { 'core.drafts.waiting': false });
		const combined = await person('Combined', noPropose);
		const stuck = await person('Stuck', noMemory);
		const { path: backup } = await backupNow(r, 'manual');

		// After the backup the family narrows some access and widens other.
		await run('core.updateMember', { memberId: demoted, roleId: 'supervised' });
		await run('core.archiveMember', { memberId: archived });
		await run('core.updateMember', { memberId: promoted, roleId: 'member' });
		await run('core.updateRole', { id: narrowed, overrides: { 'core.drafts.propose': false } });
		await run('core.updateRole', { id: widened, overrides: {} });
		await run('core.updateMember', { memberId: combined, roleId: noReceive });
		await run('core.updateMember', { memberId: stuck, roleId: noWaiting });
		const later = await person('Added later', 'member');

		await r.close();
		runtime = undefined;
		await restoreFile(config, backup, { extensions });
		const restored = await boot(config);
		await restored.kernel.worker.drain();

		const tables = restored.kernel.ctx.db.withTables<CoreTables>();
		const roleOf = async (id: string) =>
			(
				await tables
					.selectFrom('core_members')
					.select('role_id')
					.where('id', '=', id)
					.executeTakeFirst()
			)?.role_id;
		const overridesOf = async (id: string) =>
			JSON.parse(
				(
					await tables
						.selectFrom('core_roles')
						.select('overrides')
						.where('id', '=', id)
						.executeTakeFirstOrThrow()
				).overrides,
			) as Record<string, boolean>;
		const archivedAt = async (id: string) =>
			(
				await tables
					.selectFrom('core_members')
					.select('archived_at')
					.where('id', '=', id)
					.executeTakeFirst()
			)?.archived_at;

		// A demotion and an archive stay; a promotion is lost; a member added later is not brought back.
		expect(await roleOf(demoted)).toBe('supervised');
		expect(await archivedAt(archived)).not.toBeNull();
		expect(await roleOf(promoted)).toBe('supervised');
		expect(await roleOf(later)).toBeUndefined();
		// A role narrowed since stays narrow; one widened since is back to the narrower set.
		expect((await overridesOf(narrowed))['core.drafts.propose']).toBe(false);
		expect((await overridesOf(widened))['core.drafts.propose']).toBe(false);
		expect(restored.kernel.access.effective(narrowed).has('core.drafts.propose')).toBe(false);
		expect(restored.kernel.access.effective(widened).has('core.drafts.propose')).toBe(false);
		// Roles that each lack something the other has: the role lacking both when there is one,
		// else the person keeps the role they have now.
		expect(await roleOf(combined)).toBe(neither);
		expect(await roleOf(stuck)).toBe(noWaiting);
		// Everyone else is as the backup had them.
		expect(await roleOf(untouched)).toBe('member');
		expect(await roleOf(helper)).toBe(narrowed);
		expect(await roleOf(limited)).toBe(widened);
		expect(await roleOf(adminId)).toBe('admin');
		expect(await archivedAt(untouched)).toBeNull();

		// Admins are told how many people kept the access they have now.
		const note = await tables
			.selectFrom('core_notifications')
			.select(['body_key', 'body_params'])
			.where('source_id', '=', 'restore-access')
			.executeTakeFirstOrThrow();
		expect(note.body_key).toBe('app:notify_backup_restored_access_body');
		// The demoted member, the holder of the narrowed role and the two whose roles were combined.
		expect(JSON.parse(note.body_params as string)).toEqual({ count: 4 });
	});

	for (const how of ['demoted', 'archived'] as const)
		it(`the people who ran the family before keep their admin access when every admin of the backup was ${how} since`, async () => {
			const config = await newConfig();
			const r = await boot(config);
			const setup = await call('POST', '/api/v1/core/setup', {
				displayName: 'Parent',
				email: 'parent@example.com',
				password: PASSWORD,
				locale: 'en',
				setupCode: r.config.setupCode,
			});
			const parent = setup.body.id as string;
			const admin = (await signIn('parent@example.com', PASSWORD)).cookie;
			const run = async (action: string, input: unknown) => {
				const done = await call('POST', `/api/v1/actions/${action}`, input, admin);
				expect(done.body.status).toBe('applied');
				return done.body.output;
			};
			const successor = (
				await run('core.createMember', { displayName: 'Successor', roleId: 'member' })
			).id as string;
			const { path: backup } = await backupNow(r, 'manual');

			await run('core.updateMember', { memberId: successor, roleId: 'admin' });
			if (how === 'demoted') await run('core.updateMember', { memberId: parent, roleId: 'member' });
			else await run('core.archiveMember', { memberId: parent });

			await r.close();
			runtime = undefined;
			await restoreFile(config, backup, { extensions });
			const restored = await boot(config);
			await restored.kernel.worker.drain();

			const tables = restored.kernel.ctx.db.withTables<CoreTables>();
			const row = (id: string) =>
				tables
					.selectFrom('core_members')
					.select(['role_id', 'archived_at'])
					.where('id', '=', id)
					.executeTakeFirstOrThrow();
			// Without this the family would be left with nobody who can change its settings.
			expect(await row(successor)).toEqual({ role_id: 'admin', archived_at: null });
			const before = await row(parent);
			if (how === 'archived') expect(before.archived_at).not.toBeNull();
			else expect(before.role_id).toBe('member');
		});
});
