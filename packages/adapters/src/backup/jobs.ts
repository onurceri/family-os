import { basename } from 'node:path';
import { type AnyJobDefinition, BACKUP_RUN_JOB, defineJob } from '@famos/sdk';
import { z } from 'zod';
import type { BackupService } from './service.ts';
import { BackupTargetError } from './target.ts';

export const UPLOAD_JOB = 'backup.upload';
export const RUN_JOB = BACKUP_RUN_JOB;

const UploadPayload = z.object({
	targetId: z.string(),
	name: z.string().regex(/^famos-[A-Za-z0-9-]+\.tar$/),
});

/**
 * Backup jobs, registered with `KernelOptions.infrastructureJobs`. They are durable:
 * one `backup.upload` per backup and enabled target, retried with growing waits, and one
 * `backup.run` for "Back up now" so that no HTTP request writes a backup.
 */
export function createBackupJobs(deps: {
	service: BackupService;
	backupsDir: string;
	/** Writes a backup into the backups directory and returns its file name. */
	createLocalBackup(): Promise<{ name: string }>;
}): AnyJobDefinition[] {
	const upload = defineJob({
		name: UPLOAD_JOB,
		payload: UploadPayload,
		// An upload holds its lane (one job at a time), so the limit is generous but finite.
		timeoutMs: 50 * 60 * 1000,
		lane: 'long',
		maxAttempts: 5,
		backoff: (attempt) => Math.min(5 * 60_000 * 4 ** (attempt - 1), 4 * 60 * 60_000),
		async handle(ctx, { targetId, name }, run) {
			// A removed or paused target skips its queued uploads.
			if (!(await deps.service.isActive(targetId))) return;
			const target = (await deps.service.listTargets()).find((t) => t.id === targetId);
			const fail = async (code: string) => {
				await deps.service.record(targetId, code);
				await ctx.notify({
					kind: 'core.backupFailed',
					to: { capability: 'core.settings.manage' },
					title: { key: 'app:notify_backup_failed_title' },
					body: {
						key: 'app:notify_backup_failed_body',
						params: { target: target?.name ?? '', code },
					},
					url: '/settings/backups',
					source: { kind: 'backup_target', id: targetId },
					dedupeKey: `backup-failed:${targetId}:${name}`,
				});
			};
			try {
				const { size } = await deps.service.upload(
					targetId,
					`${deps.backupsDir}/${basename(name)}`,
				);
				await deps.service.record(targetId, 'ok', size);
			} catch (error) {
				const code = error instanceof BackupTargetError ? error.code : 'unreachable';
				const retryable = error instanceof BackupTargetError ? error.retryable : true;
				if (!retryable) {
					// Waiting will not help (wrong credentials, no encryption chosen): tell the admins now.
					await fail(code);
					ctx.logger.error({ target: targetId, code }, 'backup upload failed');
					return;
				}
				if (run.attempt >= run.maxAttempts) {
					// Out of attempts: tell the admins once, and let the job end up dead.
					await fail(code);
					ctx.logger.error(
						{ target: targetId, code, attempt: run.attempt },
						'backup upload gave up',
					);
					throw error;
				}
				await deps.service.record(targetId, `retrying_${code}`);
				ctx.logger.warn({ target: targetId, code, attempt: run.attempt }, 'backup upload failed');
				throw error;
			}
		},
	});

	const runNow = defineJob({
		name: RUN_JOB,
		payload: z.object({}),
		timeoutMs: 10 * 60 * 1000,
		lane: 'long',
		maxAttempts: 2,
		async handle(ctx) {
			const { name } = await deps.createLocalBackup();
			await enqueueUploads(ctx, deps.service, name);
		},
	});

	return [upload, runNow];
}

/** One durable upload job per enabled target; enqueuing the same backup twice adds nothing. */
export async function enqueueUploads(
	ctx: {
		enqueue(job: string, payload: unknown, options?: { dedupeKey?: string }): Promise<string>;
	},
	service: BackupService,
	name: string,
): Promise<number> {
	const ids = await service.enabledTargetIds();
	for (const targetId of ids)
		await ctx.enqueue(
			UPLOAD_JOB,
			{ targetId, name },
			{ dedupeKey: `backup-upload:${targetId}:${name}` },
		);
	return ids.length;
}
