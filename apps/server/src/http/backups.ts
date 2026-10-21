import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type BackupService,
	EncryptionStatusSchema,
	TargetInputSchema,
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
 * Backups for admins: what to read, and the secrets. The encryption passphrase and the targets'
 * credentials are secrets, so like AI keys and the Telegram token these routes call the adapter
 * directly and record themselves in the audit log. Running a backup, choosing no or public-key
 * encryption, a target's name, retention and switch, and removing a target are actions
 * (`core.runBackup` ...). Nothing secret is ever returned. The backup itself is a job: no
 * request writes a backup or talks to a remote store, except the connection test.
 */
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const body = <S extends z.ZodType>(schema: S) => ({
	body: { content: { 'application/json': { schema } }, required: true as const },
});
const base = { tags: ['backups'], security: [{ session: [] }] };
const TargetParams = z.object({ targetId: z.string() });
const PassphraseInputSchema = z.object({ passphrase: z.string().min(12).max(500) });
const TargetConfigPatchSchema = z.object({
	config: z.record(z.string(), z.union([z.string(), z.boolean()])),
});

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
		return actor;
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

	const setPassphrase = createRoute({
		...base,
		method: 'put',
		path: '/api/v1/backups/encryption/passphrase',
		operationId: 'backups.setPassphrase',
		summary: 'Encrypt backups with a passphrase (stored encrypted, never returned)',
		request: body(PassphraseInputSchema),
		responses: {
			200: { description: 'Encryption', ...json(EncryptionStatusSchema) },
			...errorResponses,
		},
	});
	app.openapi(setPassphrase, async (c) => {
		const actor = requireAdmin(c);
		const status = await backups.setEncryption({
			mode: 'passphrase',
			passphrase: c.req.valid('json').passphrase,
		});
		// The passphrase is a secret, so this stays a route; the row says only that it was set.
		await kernel.audit.record(actor, 'backups.setPassphrase');
		return c.json(status, 200);
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
		const actor = requireAdmin(c);
		const target = await backups.createTarget(c.req.valid('json'));
		// Its address and keys are one sealed credential, so adding it stays a route; the row
		// names the target, never what was typed.
		await kernel.audit.record(actor, 'backups.createTarget', target.id);
		return c.json(target, 201);
	});

	const updateTargetConfig = createRoute({
		...base,
		method: 'put',
		path: '/api/v1/backups/targets/{targetId}/config',
		operationId: 'backups.updateTargetConfig',
		summary: 'Change a target’s address or credentials; fields left empty keep their stored value',
		request: { params: TargetParams, ...body(TargetConfigPatchSchema) },
		responses: {
			200: { description: 'Target', ...json(TargetStatusSchema) },
			...errorResponses,
		},
	});
	app.openapi(updateTargetConfig, async (c) => {
		const actor = requireAdmin(c);
		const { targetId } = c.req.valid('param');
		const target = await backups.updateTarget(targetId, c.req.valid('json'));
		// The settings and keys are one sealed credential: the row names the target only.
		await kernel.audit.record(actor, 'backups.updateTargetConfig', targetId);
		return c.json(target, 200);
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
