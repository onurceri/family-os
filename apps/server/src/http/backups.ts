import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type BackupService,
	EncryptionStatusSchema,
	TargetInputSchema,
	TargetStatusSchema,
	TestResultSchema,
} from '@famos/adapters/backup';
import type { Identity } from '@famos/adapters/identity-betterauth';
import { CORE_CAPABILITIES, type Kernel } from '@famos/core';
import { KEEP_BEFORE_UPDATE } from '@famos/db';
import { assertFullSignIn, FamosError, personPresent, selfOf } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';
import { body, json, requireCapability } from './route-kit.ts';

/**
 * Backups for admins: what to read, and the secrets. The encryption passphrase and the targets'
 * credentials are secrets, so like AI keys and the Telegram token these routes call the adapter
 * directly and record themselves in the audit log. Running a backup, choosing no or public-key
 * encryption, a target's name, retention and switch, and removing a target are actions
 * (`core.runBackup` ...). Nothing secret is ever returned. The backup itself is a job: no
 * request writes a backup or talks to a remote store, except the connection test.
 *
 * The server's key file is the master key of everything sealed, so saving it is a route too: it
 * shows a secret. Only a person at a password sign-in who holds the settings capability gets it,
 * and only after typing their password again.
 *
 * A local backup can be saved from the browser. It holds all the family's data, unencrypted when
 * no encryption is set, so it goes only to a person at a password sign-in who holds the settings
 * capability, and each download is recorded in the audit log.
 */
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

/**
 * A bare backup file name in the backups folder: plain letters, digits, dots, dashes and
 * underscores only, so never a path, never one that climbs out, and safe in a header.
 */
const isLocalBackupName = (name: string) =>
	LOCAL_BACKUP.test(name) && /^[\w.-]+$/.test(name) && !name.includes('..');

export interface BackupRoutesDeps {
	backups: BackupService;
	identity: Pick<Identity, 'confirmPassword'>;
	/** The client address for the sign-in locks. */
	clientIp: (c: Context) => string;
	/** What the data folder's `secret` file holds (or `FAMOS_SECRET`); none where there is no server. */
	keyFile?: string;

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
	const requireAdmin = (c: Context<AppEnv>) =>
		requireCapability(
			c,
			kernel.access,
			CORE_CAPABILITIES.settingsManage.id,
			'Not allowed to manage backups',
		);

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

	const keyFile = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/backups/key-file',
		operationId: 'backups.downloadKeyFile',
		summary: 'Save the server’s key file, after typing the password again',
		request: body(z.object({ password: z.string().min(1).max(200) })),
		responses: {
			200: {
				description: 'The key file, as a download',
				content: { 'text/plain': { schema: z.string() } },
			},
			...errorResponses,
		},
	});
	app.openapi(keyFile, async (c) => {
		const actor = requireAdmin(c);
		assertFullSignIn(actor);
		const memberId = selfOf(actor);
		if (!memberId || !personPresent(actor))
			throw new FamosError('unauthenticated', 'Sign in required');
		if (deps.keyFile === undefined) throw new FamosError('not_found', 'No key file');
		const check = await deps.identity.confirmPassword(
			memberId,
			c.req.valid('json').password,
			deps.clientIp(c),
		);
		if (check.result === 'locked')
			throw new FamosError('limit_reached', 'Too many wrong passwords. Try again later.', {
				retryAfter: check.retryAfter,
			});
		if (check.result === 'wrong')
			throw new FamosError('forbidden', 'The password is not right', { reason: 'wrong_password' });
		// The row says that the file was saved and by whom, never what it holds.
		await kernel.audit.record(actor, 'core.downloadKeyFile', null);
		return c.text(`${deps.keyFile}\n`, 200, {
			'content-type': 'text/plain; charset=utf-8',
			'content-disposition': 'attachment; filename="familyos-secret"',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		});
	});

	const download = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/backups/local/{name}',
		operationId: 'backups.downloadBackup',
		summary: 'Save a local backup from the server’s backups folder, as a download',
		request: { params: z.object({ name: z.string() }) },
		responses: {
			200: {
				description: 'The backup file, as a download',
				content: { 'application/x-tar': { schema: z.string().openapi({ format: 'binary' }) } },
			},
			...errorResponses,
		},
	});
	app.openapi(download, async (c) => {
		const actor = requireAdmin(c);
		assertFullSignIn(actor);
		if (!personPresent(actor)) throw new FamosError('unauthenticated', 'Sign in required');
		const { name } = c.req.valid('param');
		const missing = () => new FamosError('not_found', 'No such backup');
		if (!isLocalBackupName(name)) throw missing();
		const path = join(deps.dir, name);
		const info = await stat(path).catch(() => null);
		if (!info?.isFile()) throw missing();
		// The row names the file and who saved it; the file itself is streamed, never held in memory.
		await kernel.audit.record(actor, 'core.downloadBackup', name);
		return new Response(ReadableStream.from(createReadStream(path)), {
			headers: {
				'content-type': 'application/x-tar',
				'content-length': String(info.size),
				'content-disposition': `attachment; filename="${name}"`,
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff',
			},
		});
	});
}
