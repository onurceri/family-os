import { basename } from 'node:path';
import {
	type BackupService,
	backupMigrations,
	createBackupJobs,
	createBackupService,
	enqueueUploads,
} from '@famos/adapters/backup';
import {
	connectImap,
	createDirMailbox,
	createEmail,
	createEmailJobs,
	POLL_JOB as EMAIL_POLL_JOB,
	type Email,
	emailMigrations,
	type MailboxConnect,
} from '@famos/adapters/email';
import { createFsFileStore } from '@famos/adapters/files-fs';
import { createGuardedHttp } from '@famos/adapters/http-guard';
import {
	createIdentity,
	type Identity,
	type IdentityOptions,
	identityMigrations,
} from '@famos/adapters/identity-betterauth';
import {
	type AiSettingsService,
	aiMigrations,
	createAiSdkLlm,
	createAiSettings,
	createSecretBox,
} from '@famos/adapters/llm-aisdk';
import {
	createSqliteQueue,
	queueMigrations,
	type SqliteJobQueue,
} from '@famos/adapters/queue-sqlite';
import { createLogger, systemClock, uuidv7Ids } from '@famos/adapters/runtime';
import { createExtensionSecrets } from '@famos/adapters/secrets';
import { createTelegram, type Telegram, telegramMigrations } from '@famos/adapters/telegram';
import { createWebPush, type WebPush, webPushMigrations } from '@famos/adapters/webpush';
import {
	CORE_CAPABILITIES,
	createKernel,
	type ExtensionPackagesPort,
	type Kernel,
	type RefusedExtension,
} from '@famos/core';
import {
	createBackup,
	type DatabaseHandle,
	openDatabase,
	planMigrations,
	pruneBackups,
	runMigrations,
	schemaState,
} from '@famos/db';
import type { ExtensionDefinition, ExternalHttp, Logger } from '@famos/sdk';
import pkg from '../package.json' with { type: 'json' };
import type { Config } from './config.ts';
import { wireEmail } from './email.ts';
import { deviceTokenFromHeaders } from './http/devices.ts';
import { catalogsOf, createTranslate, createVocabulary } from './i18n.ts';
import {
	createLanguageRegistry,
	findBundledLanguages,
	type LanguageRegistry,
} from './languages.ts';
import { wireTelegram } from './telegram.ts';
import { createThemeRegistry, findBundledThemes } from './themes.ts';

export const APP_VERSION: string = pkg.version;

export interface Runtime {
	config: Config;
	logger: Logger;
	handle: DatabaseHandle;
	kernel: Kernel;
	identity: Identity;
	queue: SqliteJobQueue;
	ai: AiSettingsService;
	webPush: WebPush;
	telegram: Telegram;
	email: Email;
	backups: BackupService;
	languages: LanguageRegistry;
	close(): Promise<void>;
}

/**
 * The composition root: the only place that knows every concrete implementation.
 * Opening the runtime does not migrate; call `migrate()` explicitly.
 */
export function openRuntime(
	config: Config,
	options: {
		/** The extensions to run (core is always there): what `loadExtensions` found, or a test's. */
		extensions: readonly ExtensionDefinition[];
		/** The database, when it was opened to choose the extensions; opened here otherwise. */
		handle?: DatabaseHandle;
		/** The packages extensions are installed from, the ones the kernel may leave out, and the
		 * installed ones that could not be loaded (`loadInstalled`). */
		extensionPackages?: ExtensionPackagesPort;
		refusable?: readonly string[];
		refused?: readonly RefusedExtension[];
		logger?: Logger;
		quiet?: boolean;
		/** Tests: where the Bot API lives, and how fast the poller works. */
		telegramApiRoot?: string;
		/** Tests: how the mailbox is reached (default: IMAP, or `FAMOS_EMAIL_FAKE_DIR`). */
		emailConnect?: MailboxConnect;
		/** Tests: the guarded outbound HTTP extensions' jobs use (default: the real, guarded one). */
		http?: ExternalHttp;
		/** Tests: the `fetch` backup targets use, and a cheap age passphrase cost. */
		backupFetch?: typeof fetch;
		scryptWorkFactor?: number;
		/** Tests: a cheap password hash in place of scrypt, so sign-in speed does not depend on machine load. */
		passwordHasher?: IdentityOptions['passwordHasher'];
		telegramTiming?: {
			pollTimeoutSeconds: number;
			conflictMs: number;
			idleMs: number;
			errorBaseMs: number;
			errorMaxMs: number;
		};
	},
): Runtime {
	const logger = options.logger ?? createLogger({ level: config.logLevel });
	const handle = options.handle ?? openDatabase({ path: config.dbPath });
	const queue = createSqliteQueue({ db: handle.db, clock: systemClock, ids: uuidv7Ids });
	// The identity adapter asks core whether a request comes from a trusted device (PIN sign-in).
	let kernelRef: Kernel | undefined;
	const identity = createIdentity({
		db: handle.db,
		secret: config.secret,
		baseURL: config.baseURL,
		trustedOrigins: config.trustedOrigins,
		...(options.quiet && { quiet: true }),
		...(options.passwordHasher && { passwordHasher: options.passwordHasher }),
		mayUsePin: async (memberId) => {
			const kernel = kernelRef;
			if (!kernel) return false;
			const member = (await kernel.ctx.family.members()).find((m) => m.id === memberId);
			return (
				member !== undefined &&
				kernel.access.effective(member.roleId).has(CORE_CAPABILITIES.signInPin.id)
			);
		},
		// Only family devices: a display (kind `kiosk`) never enables PIN sign-in.
		trustedDevice: async (headers) => {
			const device = await kernelRef?.devices.verify(deviceTokenFromHeaders(headers));
			return device?.kind === 'family' ? device.id : null;
		},
	});
	// Monthly AI limits and usage follow the family's calendar month.
	const timeZone = async () =>
		kernelRef ? (await kernelRef.ctx.family.settings()).timeZone : 'UTC';
	const ai = createAiSettings({
		db: handle.db,
		box: createSecretBox(config.secret),
		clock: systemClock,
		ids: uuidv7Ids,
		timeZone,
	});
	// Push needs HTTPS in practice (service workers, push services); the base URL is the VAPID contact.
	const webPush = createWebPush({
		db: handle.db,
		box: createSecretBox(config.secret),
		clock: systemClock,
		ids: uuidv7Ids,
		logger,
		baseURL: config.baseURL,
	});
	// Long polling needs no public address; the base URL only builds the "Open" buttons.
	const telegram = createTelegram({
		db: handle.db,
		box: createSecretBox(config.secret),
		clock: systemClock,
		logger,
		baseURL: config.baseURL,
		// Pages showing the bot or a link refresh (ids only; the hub forwards every bus event).
		onStatusChange: () => void kernelRef?.bus.publish('telegram.status.changed', {}),
		onLinkChange: (memberId) => void kernelRef?.bus.publish('telegram.link.changed', { memberId }),
		vocabulary: (key) => kernelRef?.ctx.vocabulary(key) ?? [],
		...((options.telegramApiRoot ?? config.telegramApiRoot) && {
			apiRoot: (options.telegramApiRoot ?? config.telegramApiRoot) as string,
		}),
		...(options.telegramTiming && {
			pollTimeoutSeconds: options.telegramTiming.pollTimeoutSeconds,
			timing: options.telegramTiming,
		}),
	});
	// Mail is polled by a job in the worker; the scheduler (`email.start`) queues it when due.
	const email = createEmail({
		db: handle.db,
		box: createSecretBox(config.secret, 'email'),
		clock: systemClock,
		logger,
		connect:
			options.emailConnect ??
			(config.emailFakeDir ? createDirMailbox(config.emailFakeDir) : connectImap),
		enqueuePoll: async () => {
			await queue.enqueue(handle.db, EMAIL_POLL_JOB, {}, { dedupeKey: EMAIL_POLL_JOB });
		},
		// The share target's limits, read when mail is read: the kernel that knows the target is
		// created after the adapter. Without a target nothing can be shared, so no file is kept.
		limits: {
			get maxFiles() {
				return kernelRef?.shareLimits()?.maxFiles ?? 0;
			},
			get maxBytes() {
				return kernelRef?.shareLimits()?.maxBytes ?? 0;
			},
			maxTextChars: 20_000,
			maxTitleChars: 300,
		},
		onStatusChange: () => void kernelRef?.bus.publish('email.status.changed', {}),
	});
	const backups = createBackupService({
		db: handle.db,
		box: createSecretBox(config.secret, 'backup'),
		clock: systemClock,
		ids: uuidv7Ids,
		logger,
		...(options.backupFetch && { fetch: options.backupFetch }),
		...(options.scryptWorkFactor && { scryptWorkFactor: options.scryptWorkFactor }),
	});
	const llm = createAiSdkLlm({
		db: handle.db,
		settings: ai,
		clock: systemClock,
		ids: uuidv7Ids,
		logger,
		timeZone,
		// Core owns the per-area setting; until the kernel exists nothing is open.
		areaAccess: (id) => kernelRef?.aiAreas.access(id) ?? 'off',
	});
	const loaded = options.extensions;
	const languages = createLanguageRegistry({
		...catalogsOf(loaded),
		appVersion: APP_VERSION,
		bundledDir: findBundledLanguages(config.bundledLanguagesDir),
		installedDir: config.languagesDir,
		logger,
	});
	const themes = createThemeRegistry({
		appVersion: APP_VERSION,
		bundledDir: findBundledThemes(config.bundledThemesDir),
		installedDir: config.themesDir,
		logger,
	});
	const kernel = createKernel({
		db: handle.db,
		queue,
		clock: systemClock,
		ids: uuidv7Ids,
		logger,
		files: createFsFileStore(config.filesDir),
		secrets: createExtensionSecrets(config.secret),
		http: options.http ?? createGuardedHttp(),
		identity: identity.admin,
		llm,
		extensions: loaded,
		...(options.extensionPackages && { extensionPackages: options.extensionPackages }),
		...(options.refusable && { refusable: options.refusable }),
		...(options.refused && { refused: options.refused }),
		infrastructureJobs: [
			...createEmailJobs(email),
			...createBackupJobs({
				service: backups,
				backupsDir: config.backupsDir,
				createLocalBackup: async () => ({
					name: basename((await writeBackup({ handle, config }, 'manual')).path),
				}),
			}),
		],
		infrastructureMigrations: [
			{ scope: 'queue', migrations: queueMigrations },
			{ scope: 'identity', migrations: identityMigrations },
			{ scope: 'ai', migrations: aiMigrations },
			{ scope: 'webpush', migrations: webPushMigrations },
			{ scope: 'telegram', migrations: telegramMigrations },
			{ scope: 'email', migrations: emailMigrations },
			{ scope: 'backup', migrations: backupMigrations },
		],
		appVersion: APP_VERSION,
		setupCode: config.setupCode,
		translate: createTranslate(languages),
		vocabulary: createVocabulary(languages),
		languages,
		themes,
		channels: [webPush.channel, telegram.channel],
		...(config.notifyDelayMs !== undefined && { draftNotifyDelayMs: config.notifyDelayMs }),
	});
	kernelRef = kernel;
	wireTelegram(telegram, kernel);
	wireEmail(email, kernel);
	return {
		config,
		logger,
		handle,
		kernel,
		identity,
		queue,
		ai,
		webPush,
		telegram,
		email,
		backups,
		languages,
		async close() {
			await kernel.stop();
			await handle.close();
		},
	};
}

/**
 * Applies pending migrations. Refuses a database newer than the code; takes a
 * pre-migration backup when an existing installation is about to change.
 */
export async function migrate(runtime: Runtime): Promise<number> {
	const { handle, kernel, config, logger } = runtime;
	const plan = await planMigrations(handle.db, kernel.migrationScopes);
	for (const { scope } of plan.orphaned)
		logger.warn({ scope }, 'data of an extension that is not installed is kept and not used');
	if (plan.pending.length === 0) return 0;

	const state = await schemaState(handle.db);
	if (Object.keys(state).length > 0) {
		const { path } = await createBackup({
			sqlite: handle.sqlite,
			filesDir: config.filesDir,
			languagesDir: config.languagesDir,
			themesDir: config.themesDir,
			backupsDir: config.backupsDir,
			appVersion: APP_VERSION,
			schema: state,
			reason: 'pre-migration',
		});
		await pruneBackups(config.backupsDir, 'pre-migration', 5);
		logger.info({ path }, 'pre-migration backup written');
	}
	await runMigrations(handle.db, kernel.migrationScopes);
	logger.info({ applied: plan.pending.map((p) => `${p.scope}/${p.name}`) }, 'migrations applied');
	return plan.pending.length;
}

/**
 * The provider and models from `FAMOS_AI_*`, kept in line on every start: changing or
 * removing the variables takes effect after a restart. Never logs the key.
 */
export async function seedAi(runtime: Runtime): Promise<void> {
	const seed = runtime.config.aiSeed ?? null;
	const result = await runtime.ai.syncFromEnvironment(seed);
	if (result !== 'unchanged')
		runtime.logger.info(
			{ result, ...(seed && { kind: seed.kind }) },
			'AI provider from the server configuration',
		);
}

async function writeBackup(
	runtime: Pick<Runtime, 'handle' | 'config'>,
	reason: 'manual' | 'scheduled',
) {
	const { handle, config } = runtime;
	const result = await createBackup({
		sqlite: handle.sqlite,
		filesDir: config.filesDir,
		languagesDir: config.languagesDir,
		themesDir: config.themesDir,
		backupsDir: config.backupsDir,
		appVersion: APP_VERSION,
		schema: await schemaState(handle.db),
		reason,
	});
	if (reason === 'scheduled')
		await pruneBackups(config.backupsDir, 'scheduled', config.backup.keep);
	return result;
}

/**
 * Writes a backup and queues its uploads to the enabled remote targets. The uploads
 * are durable jobs: they run in the worker, also after a restart.
 */
export async function backupNow(runtime: Runtime, reason: 'manual' | 'scheduled') {
	const result = await writeBackup(runtime, reason);
	await enqueueUploads(runtime.kernel.ctx, runtime.backups, basename(result.path));
	return result;
}

/** Nightly backup and queue housekeeping, checked every 10 minutes. */
export function startScheduler(runtime: Runtime): () => void {
	let lastBackupDay = '';
	const tick = async () => {
		const now = new Date();
		const day = now.toISOString().slice(0, 10);
		try {
			if (now.getHours() === runtime.config.backup.hour && lastBackupDay !== day) {
				lastBackupDay = day;
				const { path } = await backupNow(runtime, 'scheduled');
				runtime.logger.info({ path }, 'scheduled backup written');
				await runtime.queue.pruneSucceeded(7 * 24 * 60 * 60 * 1000);
			}
		} catch (error) {
			runtime.logger.error({ err: error }, 'scheduled task failed');
		}
	};
	const timer = setInterval(() => void tick(), 10 * 60 * 1000);
	timer.unref();
	return () => clearInterval(timer);
}
