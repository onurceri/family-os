import {
	type BackupEncryptionStatus,
	type BackupSettingsAdmin,
	type BackupSettingsWriter,
	type BackupTargetEdit,
	type BackupTargetStatus,
	type Clock,
	type DbExecutor,
	FamosError,
	type Logger,
} from '@famos/sdk';
import type { SecretBox } from '../secrets/index.ts';
import { isRecipient } from './encryption.ts';
import { S3ConfigSchema, WebDavConfigSchema } from './schemas.ts';
import { type BackupTables, backupTables } from './tables.ts';
import { BackupTargetError } from './target.ts';

export type TargetRow = BackupTables['backup_targets'];

/** The settings of a target as the page may see them; never a credential. */
export function presentTarget(box: SecretBox, row: TargetRow): BackupTargetStatus {
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		keep: row.keep,
		enabled: row.enabled === 1,
		lastRunAt: row.last_run_at,
		lastResult: row.last_result,
		lastSize: row.last_size,
		createdAt: row.created_at,
		summary: summaryOf(box, row),
	};
}

/** A target's configuration, opened. Throws `unreadable` when `FAMOS_SECRET` changed. */
export function openConfig(box: SecretBox, row: TargetRow): Record<string, unknown> {
	const plain = box.open(row.config);
	if (plain === null) throw new BackupTargetError('unreadable', false);
	return JSON.parse(plain) as Record<string, unknown>;
}

function summaryOf(box: SecretBox, row: TargetRow): BackupTargetStatus['summary'] {
	let config: Record<string, unknown>;
	try {
		config = openConfig(box, row);
	} catch {
		return {};
	}
	if (row.kind === 's3') {
		const c = S3ConfigSchema.safeParse(config);
		return c.success
			? {
					endpoint: c.data.endpoint,
					region: c.data.region,
					bucket: c.data.bucket,
					prefix: c.data.prefix,
					pathStyle: c.data.pathStyle,
				}
			: {};
	}
	const c = WebDavConfigSchema.safeParse(config);
	return c.success ? { url: c.data.url, username: c.data.username } : {};
}

export async function requireTarget(db: DbExecutor, id: string): Promise<TargetRow> {
	const row = await backupTables(db)
		.selectFrom('backup_targets')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Backup target not found');
	return row;
}

/** The columns of a target that hold no credential. */
export async function editTarget(
	db: DbExecutor,
	id: string,
	patch: BackupTargetEdit,
): Promise<void> {
	await requireTarget(db, id);
	const set: Partial<TargetRow> = {};
	if (patch.name !== undefined) set.name = patch.name;
	if (patch.keep !== undefined) set.keep = patch.keep;
	if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
	if (Object.keys(set).length > 0)
		await backupTables(db).updateTable('backup_targets').set(set).where('id', '=', id).execute();
}

export async function deleteTarget(db: DbExecutor, id: string): Promise<void> {
	await requireTarget(db, id);
	await backupTables(db).deleteFrom('backup_targets').where('id', '=', id).execute();
}

export type EncryptionValues =
	| { mode: 'none' }
	| { mode: 'recipient'; recipient: string }
	| { mode: 'passphrase'; sealedPassphrase: string };

export async function writeEncryption(
	db: DbExecutor,
	clock: Clock,
	values: EncryptionValues,
): Promise<BackupEncryptionStatus> {
	const row = {
		id: 1,
		encryption_mode: values.mode,
		sealed_passphrase: values.mode === 'passphrase' ? values.sealedPassphrase : null,
		recipient: values.mode === 'recipient' ? values.recipient : null,
		updated_at: clock.now(),
	};
	await backupTables(db)
		.insertInto('backup_settings')
		.values(row)
		.onConflict((oc) => oc.column('id').doUpdateSet(row))
		.execute();
	return { mode: row.encryption_mode, recipient: row.recipient };
}

export interface BackupSettingsDeps {
	box: SecretBox;
	clock: Clock;
	logger: Logger;
}

/**
 * The backup settings an admin action writes, on the unit of work's own connection. Nothing
 * here takes or returns a credential: a target's sealed settings and the passphrase are routes.
 */
export function createBackupSettingsAdmin(deps: BackupSettingsDeps): BackupSettingsAdmin {
	const log = deps.logger.child({ component: 'backup' });
	return {
		isRecipient,
		in(db): BackupSettingsWriter {
			return {
				async setEncryption(choice) {
					const status = await writeEncryption(db, deps.clock, choice);
					log.info({ mode: choice.mode }, 'backup encryption changed');
					return status;
				},
				async updateTarget(id, patch) {
					await editTarget(db, id, patch);
					return presentTarget(deps.box, await requireTarget(db, id));
				},
				async removeTarget(id) {
					await deleteTarget(db, id);
					log.info({ target: id }, 'backup target removed');
				},
			};
		},
	};
}
