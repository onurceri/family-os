import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import type { Clock, IdGenerator, Logger } from '@famos/sdk';
import { FamosError } from '@famos/sdk';
import type { SecretBox } from '../secrets/index.ts';
import {
	deleteTarget,
	editTarget,
	openConfig,
	presentTarget,
	requireTarget as requireTargetIn,
	type TargetRow,
	writeEncryption,
} from './admin.ts';
import { type Encryption, encryptStream, isRecipient, remoteName } from './encryption.ts';
import { createS3Target } from './s3.ts';
import {
	type EncryptionInput,
	type EncryptionStatus,
	S3ConfigSchema,
	type TargetInput,
	type TargetPatch,
	type TargetStatus,
	type TestResult,
	WebDavConfigSchema,
} from './schemas.ts';
import { backupTables } from './tables.ts';
import { type BackupTarget, BackupTargetError, expired } from './target.ts';
import { createWebDavTarget } from './webdav.ts';

export interface BackupDeps {
	db: Parameters<typeof backupTables>[0];
	box: SecretBox;
	clock: Clock;
	ids: IdGenerator;
	logger: Logger;
	/** Tests inject a stand-in; defaults to `fetch`. */
	fetch?: typeof fetch;
	/** Tests lower age's scrypt cost (default 18, about 256 MiB and a few seconds). */
	scryptWorkFactor?: number;
}

export type BackupService = ReturnType<typeof createBackupService>;

type Row = TargetRow;

/**
 * Remote backups: the encryption choice, the targets and the upload itself. Credentials
 * and the passphrase are sealed with `FAMOS_SECRET` and never returned or logged; the job queue
 * calls `upload` after each backup (see jobs.ts). Backup files on the server stay as they are:
 * encryption happens while streaming to a target.
 */
export function createBackupService(deps: BackupDeps) {
	const db = () => backupTables(deps.db);
	const log = deps.logger.child({ component: 'backup' });
	const fetchImpl = deps.fetch ?? fetch;

	const open = (row: Row) => openConfig(deps.box, row);

	function buildTarget(row: Row): BackupTarget {
		const config = open(row);
		return row.kind === 's3'
			? createS3Target(S3ConfigSchema.parse(config), fetchImpl)
			: createWebDavTarget(WebDavConfigSchema.parse(config), fetchImpl);
	}

	const toStatus = (row: Row): TargetStatus => presentTarget(deps.box, row);

	async function encryption(): Promise<Encryption> {
		const row = await db().selectFrom('backup_settings').selectAll().executeTakeFirst();
		// Never chosen: the safe default is to upload nothing.
		if (!row) throw new BackupTargetError('encryption_unset', false);
		if (row.encryption_mode === 'none') return { mode: 'none' };
		if (row.encryption_mode === 'recipient' && row.recipient)
			return { mode: 'recipient', recipient: row.recipient };
		const passphrase = row.sealed_passphrase ? deps.box.open(row.sealed_passphrase) : null;
		if (row.encryption_mode === 'passphrase' && passphrase)
			return { mode: 'passphrase', passphrase };
		throw new BackupTargetError('unreadable', false);
	}

	const findTarget = (id: string) =>
		db().selectFrom('backup_targets').selectAll().where('id', '=', id).executeTakeFirst();
	async function encryptionStatus(): Promise<EncryptionStatus> {
		const row = await db().selectFrom('backup_settings').selectAll().executeTakeFirst();
		return { mode: row?.encryption_mode ?? 'unset', recipient: row?.recipient ?? null };
	}

	const requireTarget = (id: string) => requireTargetIn(deps.db, id);

	return {
		encryptionStatus,

		async setEncryption(input: EncryptionInput): Promise<EncryptionStatus> {
			if (input.mode === 'recipient' && !(await isRecipient(input.recipient)))
				throw new FamosError('bad_request', 'This is not an age public key (it starts with age1)');
			const status = await writeEncryption(
				deps.db,
				deps.clock,
				input.mode === 'passphrase'
					? { mode: 'passphrase', sealedPassphrase: deps.box.seal(input.passphrase) }
					: input,
			);
			log.info({ mode: input.mode }, 'backup encryption changed');
			return status;
		},

		async listTargets(): Promise<TargetStatus[]> {
			const all = await db()
				.selectFrom('backup_targets')
				.selectAll()
				.orderBy('created_at')
				.execute();
			return all.map(toStatus);
		},

		async enabledTargetIds(): Promise<string[]> {
			return (
				await db().selectFrom('backup_targets').select('id').where('enabled', '=', 1).execute()
			).map((r) => r.id);
		},

		async createTarget(input: TargetInput): Promise<TargetStatus> {
			const row = {
				id: deps.ids.next('backup_target'),
				kind: input.kind,
				name: input.name,
				config: deps.box.seal(JSON.stringify(input.config)),
				keep: input.keep,
				enabled: 1,
				last_run_at: null,
				last_result: null,
				last_size: null,
				created_at: deps.clock.now(),
			};
			await db().insertInto('backup_targets').values(row).execute();
			log.info({ target: row.id, kind: row.kind }, 'backup target added');
			return toStatus(row);
		},

		async updateTarget(id: string, patch: TargetPatch): Promise<TargetStatus> {
			const row = await requireTarget(id);
			const { config, ...plain } = patch;
			await editTarget(deps.db, id, plain);
			if (config) {
				// Empty fields (a password left blank in the form) keep their stored value.
				const given = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== ''));
				const merged = { ...open(row), ...given };
				const parsed = (row.kind === 's3' ? S3ConfigSchema : WebDavConfigSchema).safeParse(merged);
				if (!parsed.success)
					throw new FamosError('bad_request', 'Invalid target settings', parsed.error.issues);
				await db()
					.updateTable('backup_targets')
					.set({ config: deps.box.seal(JSON.stringify(parsed.data)) })
					.where('id', '=', id)
					.execute();
			}
			return toStatus(await requireTarget(id));
		},

		async removeTarget(id: string): Promise<void> {
			await deleteTarget(deps.db, id);
			log.info({ target: id }, 'backup target removed');
		},

		async testTarget(id: string): Promise<TestResult> {
			const row = await requireTarget(id);
			try {
				await buildTarget(row).test();
				return { ok: true, code: 'ok' };
			} catch (error) {
				const code = error instanceof BackupTargetError ? error.code : 'unreachable';
				log.warn({ target: id, kind: row.kind, code }, 'backup target test failed');
				return { ok: false, code };
			}
		},

		/** Whether the target exists and is enabled (a removed or paused target skips its jobs). */
		async isActive(id: string): Promise<boolean> {
			const row = await findTarget(id);
			return row !== undefined && row.enabled === 1;
		},

		async record(id: string, code: string, size?: number): Promise<void> {
			await db()
				.updateTable('backup_targets')
				.set({
					last_run_at: deps.clock.now(),
					last_result: code,
					...(size !== undefined && { last_size: size }),
				})
				.where('id', '=', id)
				.execute();
		},

		/**
		 * Sends a local backup to a target, encrypted as configured, then applies the target's
		 * retention. Overwrites a file of the same name, so a retry is safe. Throws a
		 * `BackupTargetError` whose `retryable` tells the job whether trying again can help.
		 */
		async upload(id: string, file: string): Promise<{ size: number; remoteName: string }> {
			const row = await requireTarget(id);
			const target = buildTarget(row);
			const enc = await encryption();
			const name = remoteName(basename(file), enc);
			const plainSize = (await stat(file).catch(() => null))?.size;
			if (plainSize === undefined) throw new BackupTargetError('missing_local', false);
			const reader = createReadStream(file);
			const source = Readable.toWeb(reader) as ReadableStream<Uint8Array>;
			try {
				let size = plainSize;
				let body = source;
				if (enc.mode !== 'none') {
					const encrypted = await encryptStream(source, plainSize, enc, deps.scryptWorkFactor);
					body = encrypted.stream;
					size = encrypted.size;
				}
				await target.put(name, body, size);
				log.info(
					{ target: id, kind: row.kind, size, encrypted: enc.mode !== 'none' },
					'backup uploaded',
				);
				// Retention must not fail an upload that succeeded.
				try {
					for (const old of expired(await target.list(), row.keep)) await target.delete(old);
				} catch (error) {
					log.warn(
						{ target: id, code: error instanceof BackupTargetError ? error.code : 'unknown' },
						'backup retention failed',
					);
				}
				return { size, remoteName: name };
			} finally {
				reader.destroy();
			}
		},

		/** For tests and the retention check: the target as a port. */
		async port(id: string): Promise<BackupTarget> {
			return buildTarget(await requireTarget(id));
		},
	};
}
