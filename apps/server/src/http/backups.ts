import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type BackupService,
	EncryptionInputSchema,
	EncryptionStatusSchema,
	RUN_JOB,
	TargetInputSchema,
	TargetPatchSchema,
	TargetStatusSchema,
	TestResultSchema,
} from '@famos/adapters/backup';
import { CORE_CAPABILITIES, type Kernel } from '@famos/core';
import { KEEP_BEFORE_UPDATE } from '@famos/db';
import { FamosError } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';

/**
 * Backups for admins. The encryption passphrase and the targets' credentials are
 * secrets, so like AI keys and the Telegram token these routes call the adapter directly instead
 * of going through actions. Nothing secret is ever returned. The backup itself is a job: no
 * request writes a backup or talks to a remote store, except the connection test.
 */
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const body = <S extends z.ZodType>(schema: S) => ({
	body: { content: { 'application/json': { schema } }, required: true as const },
});
const base = { tags: ['backups'], security: [{ session: [] }] };
const TargetParams = z.object({ targetId: z.string() });

const LocalBackupSchema = z.object({
	name: z.string(),
	size: z.number().int(),
	createdAt: z.number().int(),
	reason: z.enum(['manual', 'scheduled', 'pre-migration']),
});
const BackupsSchema = z.object({
	local: z.array(LocalBackupSchema),
	encryption: EncryptionStatusSchema,
	targets: z.array(TargetStatusSchema),
	schedule: z.object({
		hour: z.number().int(),
		/** Nightly copies kept. */
		keep: z.number().int(),
		/** Copies made before an update that are kept. */
		keepBeforeUpdate: z.number().int(),
	}),
});
const Queued = z.object({ queued: z.literal(true) });

const LOCAL_BACKUP = /^famos-.+-(manual|scheduled|pre-migration)\.tar$/;

export interface BackupRoutesDeps {
	backups: BackupService;
	kernel: Kernel;
	dir: string;
	schedule: { hour: number; keep: number };
}

async function localBackups(dir: string) {
	const names = await readdir(dir).catch(() => [] as string[]);
	const list = await Promise.all(
		names
			.filter((n) => LOCAL_BACKUP.test(n))
			.map(async (name) => {
				const info = await stat(join(dir, name)).catch(() => null);
				return info
					? {
							name,
							size: info.size,
							createdAt: Math.round(info.mtimeMs),
							reason: LOCAL_BACKUP.exec(name)?.[1] as z.infer<typeof LocalBackupSchema>['reason'],
						}
					: null;
			}),
	);
	return list
		.filter((b) => b !== null)
		.sort((a, b) => b.name.localeCompare(a.name))
		.slice(0, 30);
}

export function mountBackupRoutes(app: OpenAPIHono<AppEnv>, deps: BackupRoutesDeps): void {
	const { backups, kernel } = deps;
	const requireAdmin = (c: Context<AppEnv>) => {
		const actor = c.get('actor');
		if (!actor) throw new FamosError('unauthenticated', 'Sign in required');
		if (!kernel.access.can(actor, CORE_CAPABILITIES.settingsManage.id))
			throw new FamosError('forbidden', 'Not allowed to manage backups');
	};

	const list = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/backups',
		operationId: 'backups.list',
		summary: 'Local backups, remote targets with their last result, and the encryption mode',
		responses: { 200: { description: 'Backups', ...json(BackupsSchema) }, ...errorResponses },
	});
	app.openapi(list, async (c) => {
		requireAdmin(c);
		return c.json(
			{
				local: await localBackups(deps.dir),
				encryption: await backups.encryptionStatus(),
				targets: await backups.listTargets(),
				schedule: { ...deps.schedule, keepBeforeUpdate: KEEP_BEFORE_UPDATE },
			},
			200,
		);
	});

	const run = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/backups/run',
		operationId: 'backups.run',
		summary: 'Write a backup now and send it to the enabled targets (runs in the background)',
		responses: { 202: { description: 'Queued', ...json(Queued) }, ...errorResponses },
	});
	app.openapi(run, async (c) => {
		requireAdmin(c);
		// Pressing the button twice queues one backup.
		await kernel.ctx.enqueue(RUN_JOB, {}, { dedupeKey: RUN_JOB });
		return c.json({ queued: true as const }, 202);
	});

	const setEncryption = createRoute({
		...base,
		method: 'put',
		path: '/api/v1/backups/encryption',
		operationId: 'backups.setEncryption',
		summary: 'Choose how backups are encrypted before they leave the server',
		request: body(EncryptionInputSchema),
		responses: {
			200: { description: 'Encryption', ...json(EncryptionStatusSchema) },
			...errorResponses,
		},
	});
	app.openapi(setEncryption, async (c) => {
		requireAdmin(c);
		return c.json(await backups.setEncryption(c.req.valid('json')), 200);
	});

	const createTarget = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/backups/targets',
		operationId: 'backups.createTarget',
		summary: 'Add a remote target; credentials are stored encrypted and never returned',
		request: body(TargetInputSchema),
		responses: {
			201: { description: 'Target added', ...json(TargetStatusSchema) },
			...errorResponses,
		},
	});
	app.openapi(createTarget, async (c) => {
		requireAdmin(c);
		return c.json(await backups.createTarget(c.req.valid('json')), 201);
	});

	const updateTarget = createRoute({
		...base,
		method: 'patch',
		path: '/api/v1/backups/targets/{targetId}',
		operationId: 'backups.updateTarget',
		summary: 'Rename, pause, change retention or settings; credentials left out keep their value',
		request: { params: TargetParams, ...body(TargetPatchSchema) },
		responses: {
			200: { description: 'Target', ...json(TargetStatusSchema) },
			...errorResponses,
		},
	});
	app.openapi(updateTarget, async (c) => {
		requireAdmin(c);
		return c.json(
			await backups.updateTarget(c.req.valid('param').targetId, c.req.valid('json')),
			200,
		);
	});

	const deleteTarget = createRoute({
		...base,
		method: 'delete',
		path: '/api/v1/backups/targets/{targetId}',
		operationId: 'backups.deleteTarget',
		summary: 'Remove a target (files already uploaded stay where they are)',
		request: { params: TargetParams },
		responses: {
			200: { description: 'Removed', ...json(z.object({ ok: z.literal(true) })) },
			...errorResponses,
		},
	});
	app.openapi(deleteTarget, async (c) => {
		requireAdmin(c);
		await backups.removeTarget(c.req.valid('param').targetId);
		return c.json({ ok: true as const }, 200);
	});

	const testTarget = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/backups/targets/{targetId}/test',
		operationId: 'backups.testTarget',
		summary: 'Write and delete a small probe file on the target',
		request: { params: TargetParams },
		responses: {
			200: { description: 'Test result', ...json(TestResultSchema) },
			...errorResponses,
		},
	});
	app.openapi(testTarget, async (c) => {
		requireAdmin(c);
		return c.json(await backups.testTarget(c.req.valid('param').targetId), 200);
	});
}
