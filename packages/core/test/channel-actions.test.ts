import type { BackupTables } from '@famos/adapters/backup';
import type { EmailTables } from '@famos/adapters/email';
import { createSecretBox } from '@famos/adapters/llm-aisdk';
import type { TelegramTables } from '@famos/adapters/telegram';
import { type Actor, isFamosError, type MemberId } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emailStatusChanged, telegramLinkChanged } from '../src/core-events.ts';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const sneaky = defineTestExtension({ id: 'sneaky' });

type Tables = CoreTables &
	BackupTables &
	EmailTables &
	TelegramTables & {
		queue_jobs: { name: string; payload: string; status: string; dedupe_key: string | null };
	};

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let member: Awaited<ReturnType<TestKernel['member']>>;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [sneaky] });
	admin = await k.member('admin');
	member = await k.member('member');
});
afterEach(() => k.close());

const db = () => k.ctx.db.withTables<Tables>();
const auditOf = (actionId: string) =>
	db()
		.selectFrom('core_audit_log')
		.select(['action_id', 'outcome', 'target', 'actor'])
		.where('action_id', '=', actionId)
		.execute();
const invoke = (id: string, input: unknown, actor: Actor = admin.actor) =>
	k.runner.invoke(id, input, actor);

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		const result = (await promise) as { status?: string };
		return result.status ?? 'ok';
	} catch (error) {
		if (isFamosError(error)) return error.code;
		throw error;
	}
}

const appActor: Actor = {
	kind: 'app',
	appId: 'app_0198c2a0-0000-7000-8000-000000000001',
	roleId: 'admin',
	mode: 'apply',
};
const aiFor = (memberId: MemberId): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: memberId,
	roleId: 'admin',
});
const displayActor: Actor = {
	kind: 'display',
	deviceId: 'device_0198c2a0-0000-7000-8000-000000000001',
	capabilities: [],
	showNames: false,
};

const SECRET_CONFIG = 'dav-password-must-stay-sealed';
async function newTarget() {
	const box = createSecretBox('core-test-secret', 'ai-provider-keys');
	await db()
		.insertInto('backup_targets')
		.values({
			id: 'backup_target_1',
			kind: 'webdav',
			name: 'Cloud',
			config: box.seal(
				JSON.stringify({ url: 'https://dav.example/f', username: 'anna', password: SECRET_CONFIG }),
			),
			keep: 7,
			enabled: 1,
			last_run_at: null,
			last_result: null,
			last_size: null,
			created_at: k.clock.now(),
		})
		.execute();
	return 'backup_target_1';
}
async function newMailbox() {
	await db()
		.insertInto('email_settings')
		.values({
			id: 1,
			host: 'imap.example',
			port: 993,
			tls_required: 1,
			username: 'family',
			password: 'sealed-password-blob',
			mailbox: 'INBOX',
			processed_folder: 'FamilyOS',
			poll_minutes: 5,
			enabled: 1,
			status_code: 'ok',
			status_text: null,
			last_checked_at: null,
			updated_at: k.clock.now(),
		})
		.execute();
	await db()
		.insertInto('email_seen')
		.values({ uidvalidity: 1, uid: 1, message_id: null, outcome: 'processed', processed_at: 1 })
		.execute();
}
const jobsNamed = (name: string) =>
	db().selectFrom('queue_jobs').select(['status', 'dedupe_key']).where('name', '=', name).execute();

describe('backups', () => {
	it('queues one backup however often the button is pressed, and audits each press', async () => {
		expect(await invoke('core.runBackup', {})).toMatchObject({
			status: 'applied',
			output: { queued: true },
		});
		await invoke('core.runBackup', {});
		expect(await jobsNamed('backup.run')).toEqual([
			{ status: 'pending', dedupe_key: 'backup.run' },
		]);
		expect(await auditOf('core.runBackup')).toHaveLength(2);
	});

	it('chooses no or public-key encryption, drops a passphrase, and refuses a key that is not one', async () => {
		await db()
			.insertInto('backup_settings')
			.values({
				id: 1,
				encryption_mode: 'passphrase',
				sealed_passphrase: 'sealed-blob',
				recipient: null,
				updated_at: 1,
			})
			.execute();
		expect(await invoke('core.setBackupEncryption', { mode: 'none' })).toMatchObject({
			status: 'applied',
			output: { mode: 'none', recipient: null },
		});
		expect(
			await db().selectFrom('backup_settings').select('sealed_passphrase').executeTakeFirst(),
		).toEqual({ sealed_passphrase: null });

		expect(
			await codeOf(
				invoke('core.setBackupEncryption', { mode: 'recipient', recipient: 'age1nokey000' }),
			),
		).toBe('bad_request');
		expect(
			await db().selectFrom('backup_settings').select('encryption_mode').executeTakeFirst(),
		).toEqual({ encryption_mode: 'none' });
		// A passphrase is never an input here: it is a secret and has its own route.
		expect(
			await codeOf(
				invoke('core.setBackupEncryption', { mode: 'passphrase', passphrase: 'a long enough one' }),
			),
		).toBe('bad_request');
		expect(await auditOf('core.setBackupEncryption')).toMatchObject([
			{ outcome: 'applied', target: '1' },
		]);
	});

	it('renames, pauses and removes a target, names it in the audit log and never shows its secret', async () => {
		const id = await newTarget();
		const updated = await invoke('core.updateBackupTarget', {
			targetId: id,
			name: 'Attic',
			keep: 3,
			enabled: false,
		});
		expect(updated).toMatchObject({
			status: 'applied',
			output: {
				id,
				name: 'Attic',
				keep: 3,
				enabled: false,
				summary: { url: 'https://dav.example/f', username: 'anna' },
			},
		});
		// What it connects with is untouched.
		const row = await db().selectFrom('backup_targets').select('config').executeTakeFirstOrThrow();
		expect(createSecretBox('core-test-secret', 'ai-provider-keys').open(row.config)).toContain(
			SECRET_CONFIG,
		);

		expect(await invoke('core.deleteBackupTarget', { targetId: id })).toMatchObject({
			status: 'applied',
			output: { targetId: id },
		});
		expect(await db().selectFrom('backup_targets').select('id').execute()).toEqual([]);
		expect(await codeOf(invoke('core.deleteBackupTarget', { targetId: id }))).toBe('not_found');
		expect(await codeOf(invoke('core.updateBackupTarget', { targetId: id, enabled: true }))).toBe(
			'not_found',
		);
		for (const action of ['core.updateBackupTarget', 'core.deleteBackupTarget'])
			expect(await auditOf(action)).toMatchObject([{ outcome: 'applied', target: id }]);

		const kept = JSON.stringify([
			await db().selectFrom('core_audit_log').selectAll().execute(),
			await db().selectFrom('core_idempotency').selectAll().execute(),
		]);
		expect(kept).not.toContain(SECRET_CONFIG);
	});
});

describe('the family mailbox', () => {
	it('disconnects, forgets what it saw, keeps the senders, and tells open pages', async () => {
		await newMailbox();
		await invoke('core.addEmailSender', {
			address: 'School@Example.org',
			memberId: member.member.id,
		});
		const heard: string[] = [];
		k.bus.on(emailStatusChanged, () => void heard.push('status'));
		expect(await invoke('core.disconnectEmail', {})).toMatchObject({ status: 'applied' });
		expect(await db().selectFrom('email_settings').select('id').execute()).toEqual([]);
		expect(await db().selectFrom('email_seen').select('uid').execute()).toEqual([]);
		expect(await db().selectFrom('email_senders').select('address').execute()).toEqual([
			{ address: 'school@example.org' },
		]);
		expect(heard).toEqual(['status']);
		expect(await auditOf('core.disconnectEmail')).toMatchObject([{ target: '1' }]);
	});

	it('allows an address for a member of the family only, and lets mail that waited be read again', async () => {
		await newMailbox();
		await db().updateTable('email_seen').set({ outcome: 'unknown_sender' }).execute();
		const added = await invoke('core.addEmailSender', {
			address: ' Office@School.EXAMPLE ',
			memberId: member.member.id,
			label: 'School',
		});
		expect(added).toMatchObject({
			status: 'applied',
			output: { address: 'office@school.example', memberId: member.member.id, label: 'School' },
		});
		expect(await db().selectFrom('email_seen').select('uid').execute()).toEqual([]);
		// Again for another member replaces the entry.
		await invoke('core.addEmailSender', {
			address: 'office@school.example',
			memberId: admin.member.id,
		});
		expect(await db().selectFrom('email_senders').selectAll().execute()).toMatchObject([
			{ address: 'office@school.example', member_id: admin.member.id, label: null },
		]);
		for (const bad of [
			{ address: 'x@y.example', memberId: 'member_nobody' },
			{ address: 'not-an-address', memberId: member.member.id },
		])
			expect(await codeOf(invoke('core.addEmailSender', bad))).toBe('bad_request');
		expect(
			await invoke('core.removeEmailSender', { address: 'Office@school.example' }),
		).toMatchObject({
			status: 'applied',
			output: { address: 'office@school.example' },
		});
		expect(await db().selectFrom('email_senders').select('address').execute()).toEqual([]);
		expect((await auditOf('core.addEmailSender')).map((r) => r.target)).toEqual([
			'office@school.example',
			'office@school.example',
		]);
		expect(await auditOf('core.removeEmailSender')).toMatchObject([
			{ target: 'office@school.example' },
		]);
	});

	it('does not accept mail for a member who has left', async () => {
		await invoke('core.archiveMember', { memberId: member.member.id });
		expect(
			await codeOf(
				invoke('core.addEmailSender', { address: 'a@b.example', memberId: member.member.id }),
			),
		).toBe('bad_request');
	});

	it('queues a mailbox check once, in the same unit of work', async () => {
		await invoke('core.checkEmailNow', {});
		await invoke('core.checkEmailNow', {});
		expect(await jobsNamed('email.poll')).toEqual([
			{ status: 'pending', dedupe_key: 'email.poll' },
		]);
		expect(await auditOf('core.checkEmailNow')).toHaveLength(2);
	});
});

describe('a Telegram link', () => {
	const link = (memberId: string, userId: number) =>
		db()
			.insertInto('telegram_links')
			.values({
				member_id: memberId,
				telegram_user_id: userId,
				chat_id: userId,
				username: 'someone',
				linked_at: 1,
				thread_id: null,
				waiting_reply_id: null,
			})
			.execute();

	it('ends only the caller’s own link and any code, and tells that member', async () => {
		await link(member.member.id, 1);
		await link(admin.member.id, 2);
		await db()
			.insertInto('telegram_link_codes')
			.values({ code: 'abc', member_id: member.member.id, expires_at: Date.now() + 60_000 })
			.execute();
		const heard: string[] = [];
		k.bus.on(telegramLinkChanged, ({ memberId }) => void heard.push(memberId));

		expect(await invoke('core.unlinkTelegram', {}, member.actor)).toMatchObject({
			status: 'applied',
		});
		expect(await db().selectFrom('telegram_links').select('member_id').execute()).toEqual([
			{ member_id: admin.member.id },
		]);
		expect(await db().selectFrom('telegram_link_codes').select('code').execute()).toEqual([]);
		expect(heard).toEqual([member.member.id]);
		expect(JSON.parse((await auditOf('core.unlinkTelegram'))[0]?.actor ?? '{}')).toEqual(
			member.actor,
		);
	});

	it('is a person’s own act: not an app, a display or the system, and not offered to the AI', async () => {
		await link(member.member.id, 1);
		for (const actor of [appActor, displayActor, { kind: 'system', source: 'test' } as Actor])
			expect(await codeOf(invoke('core.unlinkTelegram', {}, actor)), actor.kind).toBe('forbidden');
		// An extension acting as the AI is refused: the action has no AI hints.
		expect(
			await codeOf(
				k.contextFor('sneaky').actions.invoke(
					'core.unlinkTelegram',
					{},
					{
						kind: 'ai',
						mode: 'agent',
						source: 'sneaky',
						onBehalfOf: member.member.id as MemberId,
					},
				),
			),
		).toBe('forbidden');
		expect(
			k.ctx.actions
				.aiCatalog({ actor: aiFor(member.member.id as MemberId) })
				.some((a) => a.id === 'core.unlinkTelegram'),
		).toBe(false);
		expect(await db().selectFrom('telegram_links').select('member_id').execute()).toHaveLength(1);
		expect(await auditOf('core.unlinkTelegram')).toEqual([]);
	});
});

describe('who may', () => {
	it('refuses a member, a supervised child, an app, the AI and a display every admin change', async () => {
		const id = await newTarget();
		await newMailbox();
		const child = await k.member('supervised');
		const refused = [
			member.actor,
			child.actor,
			appActor,
			aiFor(admin.member.id as MemberId),
			displayActor,
		];
		const attempts: [string, unknown][] = [
			['core.runBackup', {}],
			['core.setBackupEncryption', { mode: 'none' }],
			['core.updateBackupTarget', { targetId: id, enabled: false }],
			['core.deleteBackupTarget', { targetId: id }],
			['core.disconnectEmail', {}],
			['core.addEmailSender', { address: 'a@b.example', memberId: admin.member.id }],
			['core.removeEmailSender', { address: 'a@b.example' }],
			['core.checkEmailNow', {}],
		];
		for (const actor of refused)
			for (const [action, input] of attempts)
				expect(await codeOf(invoke(action, input, actor)), `${action} as ${actor.kind}`).toBe(
					'forbidden',
				);
		// A PIN sign-in never holds a critical capability.
		expect(await codeOf(invoke('core.runBackup', {}, { ...admin.actor, pin: true }))).toBe(
			'forbidden',
		);
		// Nothing changed, nothing drafted, nothing audited, nothing queued.
		expect(await db().selectFrom('backup_targets').select('enabled').execute()).toEqual([
			{ enabled: 1 },
		]);
		expect(await db().selectFrom('email_settings').select('id').execute()).toHaveLength(1);
		for (const [action] of attempts.slice(1)) expect(await auditOf(action)).toEqual([]);
		expect(await db().selectFrom('core_drafts').select('id').execute()).toEqual([]);
	});

	it('are never proposed to the AI', () => {
		const ids = k.ctx.actions
			.aiCatalog({ actor: aiFor(admin.member.id as MemberId) })
			.map((a) => a.id);
		expect(
			ids.filter((action) =>
				/^core\.(runBackup|setBackupEncryption|updateBackupTarget|deleteBackupTarget|disconnectEmail|addEmailSender|removeEmailSender|checkEmailNow|unlinkTelegram)$/.test(
					action,
				),
			),
		).toEqual([]);
	});
});
