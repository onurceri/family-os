import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import { createLogger, silentLogger } from '@famos/adapters/runtime';
import {
	type CoreTables,
	type ExtensionProblem,
	isExtensionRefusedError,
	readExtensionState,
	restartRequested,
} from '@famos/core';
import { MigrationFailedError, openDatabase } from '@famos/db';
import { ARCHIVE_EXTENSION } from '@famos/pack/format';
import { systemActor } from '@famos/sdk';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { type Config, loadConfig } from './config.ts';
import {
	type InstalledExtensions,
	loadInstalled,
	recordFailure,
	recordStart,
} from './extensions/installed.ts';
import { findAvailable, type LoadedExtensions, loadExtensions } from './extensions/load.ts';
import { describePurge, previewPurge, purgeExtension, purgeTarget } from './extensions/purge.ts';
import { createHttpApp, loadedWeb, OPENAPI_INFO } from './http/app.ts';
import { publicOpenApiDocument } from './http/public/index.ts';
import { createRealtimeHub, realtimeGuard } from './http/realtime.ts';
import { mountSpa } from './http/static.ts';
import { splitOpenApi } from './openapi.ts';
import { OFFICIAL_INDEX_URL } from './packages/official.ts';
import { createExtensionStore, type ExtensionStore, withStore } from './packages/store.ts';
import { TRUST_ROOTS } from './packages/trust.ts';
import { askLine, askSecret } from './prompt.ts';
import { restoreFile } from './restore.ts';
import { finishRestore } from './restore-pending.ts';
import {
	APP_VERSION,
	backupNow,
	migrate,
	openRuntime,
	type Runtime,
	resealSecrets,
	seedAi,
	startScheduler,
} from './runtime.ts';
import { RESTART_EXIT_CODE } from './supervisor.ts';
import { type DistrustResult, distrustCertificates, logDistrust } from './tls.ts';

const USAGE = `famos ${APP_VERSION}

Usage: famos <command>

  serve              Migrate (with automatic backup) and start the server (default)
  migrate            Apply pending migrations and exit
  backup             Write a backup to $FAMOS_DATA_DIR/backups and exit
  restore <file>     Restore a backup (stop the server first). An encrypted .age file asks
                     for its passphrase (or FAMOS_BACKUP_PASSPHRASE), or use --identity <file>
  extensions list    The extensions installed and the ones that can be
  extensions install <id…> | <file.famext…> | --all-offered
                     Install extensions (what they need comes with them), shipped ones by id or
                     signed packages from a file; restart to load them
  extensions uninstall <id>
                     Uninstall an extension (its data is kept); restart to apply
  extensions purge <id> [--yes]
                     Remove an uninstalled extension's data for good (tables, files, settings),
                     after writing a backup; asks first unless --yes
  public-openapi [file]
                     Write the public API's OpenAPI document (default: public-openapi.json)
  openapi [file]     Write the OpenAPI document (default: openapi.json). With --extensions <dir>,
                     the file holds core's and the app's routes, and each extension's routes and
                     actions go to <dir>/<id>/openapi.json
`;

/** How often a process that serves no API looks whether a restart was asked for. */
const RESTART_POLL_MS = 30_000;

async function serveCommand(distrust: DistrustResult) {
	const config = await loadConfig();
	const { runtime, web, selection, store } = await openWithExtensions(config);
	const { logger, kernel } = runtime;
	logDistrust(logger, distrust);
	const extensions = loadedWeb(kernel, web);
	const boot = randomUUID();
	const bootedAt = Date.now();
	for (const refused of kernel.refused)
		logger.warn(
			{ extension: refused.id, version: refused.version, reason: refused.reason },
			'an installed extension is not loaded',
		);
	try {
		await migrate(runtime);
		await recordStart(runtime.handle.db, selection, kernel.registry.extensions, Date.now());
		await resealSecrets(runtime);
		await seedAi(runtime);
		await kernel.start();
	} catch (error) {
		const failing = failingExtension(error, selection);
		if (!failing) throw error;
		// Recorded, so the next start leaves this version out: a broken package cannot make the
		// server restart over and over, and the family keeps everything else.
		const version =
			kernel.registry.extensions.find((ext) => ext.id === failing.id)?.manifest.version ?? '';
		await recordFailure(runtime.handle.db, { ...failing, version }, Date.now());
		logger.error(
			{ extension: failing.id, version, reason: failing.reason },
			'an extension failed to start; starting again without it',
		);
		await runtime.close();
		process.exit(RESTART_EXIT_CODE);
	}
	// Before anything serves: after a restore nobody is signed in and what was ended stays ended.
	await finishRestore(runtime);
	await announceSetup(runtime);
	// Old copies in the store go once this start has chosen what it runs; the previous one of
	// each stays.
	try {
		const removed = await store.collect(selection.storedInUse);
		if (removed.length > 0) logger.info({ removed }, 'old extension packages removed');
	} catch (error) {
		logger.warn({ err: error }, 'removing old extension packages failed');
	}

	/** `finishRequests`: answer requests in flight first (a restart asked through the API). */
	const stops: ((finishRequests: boolean) => void | Promise<void>)[] = [];
	if (config.roles.worker) {
		kernel.worker.start();
		stops.push(startScheduler(runtime));
		// Polls while a bot token is saved (also one saved later) and sleeps otherwise.
		runtime.telegram.start();
		stops.push(() => runtime.telegram.stop());
		// Queues a mailbox check job whenever one is due.
		runtime.email.start();
		stops.push(() => runtime.email.stop());
	}

	if (config.roles.api) {
		const app = createHttpApp({
			kernel,
			ai: runtime.ai,
			webPush: runtime.webPush,
			telegram: runtime.telegram,
			email: runtime.email,
			backups: runtime.backups,
			backupsDir: config.backupsDir,
			backupSchedule: config.backup,
			keyFile: config.secret,
			identity: runtime.identity,
			knownDevices: runtime.knownDevices,
			logger,
			trustedOrigins: config.trustedOrigins,
			...(config.publicURL && { publicUrl: config.publicURL }),
			appVersion: APP_VERSION,
			secureCookies: config.baseURL.startsWith('https://'),
			trustedProxies: config.trustedProxies,
			extensions,
			boot,
		});
		const hub = createRealtimeHub(kernel.bus, logger, kernel.access, kernel.registry.events);
		app.get(
			'/api/v1/ws',
			realtimeGuard(config.trustedOrigins, (c) => c.get('actor')),
			upgradeWebSocket((c) => {
				const actor = c.get('actor');
				// The check above resolved the actor; a socket never opens without one.
				return hub.events(actor ?? { kind: 'system', source: 'anonymous' });
			}),
		);
		if (config.webDir) mountSpa(app, config.webDir, extensions);
		else logger.warn({}, 'FAMOS_WEB_DIR not set; serving the API only');

		const sockets = new WebSocketServer({ noServer: true });
		const server = serve(
			{
				fetch: app.fetch,
				port: config.port,
				hostname: config.host,
				websocket: { server: sockets },
			},
			(info) =>
				logger.info(
					{ port: info.port, version: APP_VERSION, baseURL: config.baseURL },
					'FamilyOS listening',
				),
		);
		// Node closes an idle keep-alive connection after 5 s; a client (or a reverse proxy) that
		// reuses it at that very moment gets ECONNRESET. Stay above the usual 60 s proxy idle timeout
		// so the other side is always the one that closes first.
		if ('keepAliveTimeout' in server) {
			server.keepAliveTimeout = 65_000;
			server.headersTimeout = 66_000;
		}
		// An upgrade leaves the HTTP server's connection list, so `closeAllConnections` does not reach
		// it, and the WebSocket may only join `sockets.clients` after an async sign-in check. Track the
		// raw sockets to be able to drop one whose handshake is still in flight at shutdown.
		const upgraded = new Set<Duplex>();
		server.on('upgrade', (_request, socket) => {
			upgraded.add(socket);
			socket.once('close', () => upgraded.delete(socket));
		});
		stops.push(
			(finishRequests) =>
				new Promise<void>((resolve) => {
					// Open WebSockets and idle keep-alive connections would hold `close` open forever.
					server.close(() => resolve());
					for (const socket of upgraded) socket.destroy();
					for (const socket of sockets.clients) socket.terminate();
					const closeAll = () => {
						if ('closeAllConnections' in server) server.closeAllConnections();
					};
					if (!finishRequests) return closeAll();
					// The request that asked for the restart still waits for its answer: idle
					// connections go now, busy ones as soon as they are answered, and none is waited
					// on for long.
					if (!('closeIdleConnections' in server)) return closeAll();
					server.closeIdleConnections();
					const idle = setInterval(() => server.closeIdleConnections(), 50);
					const late = setTimeout(closeAll, 5_000);
					server.once('close', () => {
						clearInterval(idle);
						clearTimeout(late);
					});
				}),
		);
	}

	let stopping = false;
	const shutdown = async (signal: string, code = 0) => {
		if (stopping) return;
		stopping = true;
		logger.info({ signal }, code === RESTART_EXIT_CODE ? 'restarting' : 'shutting down');
		for (const stop of stops.reverse()) await stop(code === RESTART_EXIT_CODE);
		await runtime.close();
		process.exit(code);
	};
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));
	// A restart is asked for through the API, so the process serving it hears it at once (after
	// the commit); one that serves no API looks at the stored time now and then.
	if (config.roles.api) {
		kernel.bus.on(restartRequested, () => void shutdown('restart', RESTART_EXIT_CODE));
	} else {
		const timer = setInterval(async () => {
			try {
				const at = (await readExtensionState(runtime.handle.db))?.restartRequestedAt ?? null;
				if (at !== null && at > bootedAt) await shutdown('restart', RESTART_EXIT_CODE);
			} catch (error) {
				logger.error({ err: error }, 'checking for a restart failed');
			}
		}, RESTART_POLL_MS);
		timer.unref();
		stops.push(() => clearInterval(timer));
	}
}

/** The optional extension behind a migration or start failure, or null when it is the host's. */
function failingExtension(
	error: unknown,
	selection: Pick<InstalledExtensions, 'refusable'>,
): {
	id: string;
	reason: string;
	code: ExtensionProblem;
	params?: Record<string, string>;
} | null {
	if (error instanceof MigrationFailedError && selection.refusable.includes(error.scope))
		return { id: error.scope, reason: error.message, code: 'migration_failed' };
	if (isExtensionRefusedError(error) && selection.refusable.includes(error.extensionId))
		return {
			id: error.extensionId,
			reason: error.reason,
			code: error.code,
			...(error.params && { params: error.params }),
		};
	return null;
}

/**
 * Opens the database, loads the extensions the family installed, then opens the runtime with
 * them and says in the log what it runs.
 */
async function openWithExtensions(
	config: Config,
	options: { quiet?: boolean } = {},
): Promise<{
	runtime: Runtime;
	web: LoadedExtensions['web'];
	selection: InstalledExtensions;
	store: ExtensionStore;
}> {
	const logger = createLogger({ level: config.logLevel });
	const handle = openDatabase({ path: config.dbPath });
	const store = createExtensionStore({
		dir: config.extensionsDir,
		trustRoots: TRUST_ROOTS,
		...(!options.quiet && { logger }),
	});
	let selection: InstalledExtensions;
	try {
		// Every stored copy is checked again here, before any of its code is imported.
		const available = withStore(findAvailable(), await store.scan());
		selection = await loadInstalled(handle.db, available, {
			store,
			official: { url: config.extensionIndexUrl ?? OFFICIAL_INDEX_URL, trustRoots: TRUST_ROOTS },
		});
	} catch (error) {
		await handle.close();
		throw error;
	}
	const runtime = openRuntime(config, {
		extensions: selection.extensions,
		logger,
		handle,
		extensionPackages: selection.packages,
		refusable: selection.refusable,
		refused: selection.refused,
	});
	if (!options.quiet) logLoaded(runtime, selection.report);
	return { runtime, web: selection.web, selection, store };
}

function logLoaded({ logger }: Runtime, report: LoadedExtensions['report']) {
	if (report.warning) logger.warn({ dir: report.dir }, report.warning);
	logger.info(
		{
			from: report.from,
			dir: report.dir,
			extensions: report.loaded.map((e) => `${e.id}@${e.version}`),
		},
		'extensions loaded',
	);
}

/**
 * While nobody has set the instance up, print where to do it. The code is also in
 * `data/setup-code`; whoever can read the log or the data directory owns the server anyway.
 */
async function announceSetup({ kernel, config, logger }: Runtime) {
	const member = await kernel.ctx.db
		.withTables<CoreTables>()
		.selectFrom('core_members')
		.select('id')
		.limit(1)
		.executeTakeFirst();
	if (member) return;
	const url = `${config.baseURL}/setup?code=${encodeURIComponent(config.setupCode)}`;
	logger.info(
		{ url },
		'Open this address to set up FamilyOS (the code is also in data/setup-code)',
	);
}

function generationConfig(): Config {
	return {
		dataDir: '/nonexistent',
		dbPath: ':memory:',
		filesDir: '/nonexistent/files',
		backupsDir: '/nonexistent/backups',
		languagesDir: '/nonexistent/languages',
		bundledLanguagesDir: undefined,
		themesDir: '/nonexistent/themes',
		extensionsDir: '/nonexistent/extensions',
		bundledThemesDir: undefined,
		webDir: undefined,
		port: 0,
		host: '127.0.0.1',
		baseURL: 'http://localhost',
		trustedOrigins: [],
		trustedProxies: [],
		secret: 'g'.repeat(32),
		setupCode: 'generation-only',
		roles: { api: true, worker: false },
		backup: { hour: 3, keep: 7 },
		logLevel: 'error',
	};
}

/**
 * Writes only when the content changed: type checks read these files while generation runs, and
 * an unchanged file must never be seen half-written.
 */
async function writeJson(file: string, value: unknown) {
	const text = `${JSON.stringify(value, null, '\t')}\n`;
	const current = await readFile(file, 'utf8').catch(() => null);
	if (current !== text) await writeFile(file, text);
}

/**
 * `famos extensions list|install|uninstall|purge`: changes the installed set the way Settings does,
 * as the server's own command line; the change loads when the server starts again. Purging the
 * data of an uninstalled extension is done here only.
 */
async function extensionsCommand(
	sub: string | undefined,
	ids: string[],
	flags: { allOffered: boolean; yes: boolean },
) {
	const { allOffered } = flags;
	const { runtime, selection } = await openWithExtensions(await loadConfig(), { quiet: true });
	try {
		// The installed set lives in core's tables, which a data directory never started lacks.
		await migrate(runtime);
		const { kernel } = runtime;
		const cli = systemActor('cli');
		const listed = () => kernel.listExtensions();
		const run = async (actionId: string, input: { extensionId: string } | { staged: string }) => {
			const result = await kernel.runner.invoke(actionId, input, cli);
			if (result.status !== 'applied') throw new Error(`${actionId} did not apply`);
			return result.output as { changed: string[] };
		};
		/** A package file is checked and staged first, then installed like any other. */
		const installInput = async (arg: string) => {
			if (!arg.endsWith(ARCHIVE_EXTENSION)) return { extensionId: arg };
			const stage = selection.packages.stage;
			if (!stage) throw new Error('This server cannot install from a file');
			const staged = await stage(await readFile(arg));
			console.log(
				`${arg}: ${staged.id} ${staged.version}, signed by ${staged.signer.kind} key ${staged.signer.keyId}`,
			);
			return { staged: staged.digest };
		};
		switch (sub) {
			case 'list': {
				for (const ext of (await listed()).extensions) {
					const reason = ext.reason ? `  (${ext.reason})` : '';
					console.log(
						`${ext.id.padEnd(12)} ${ext.version.padEnd(9)} ${ext.status}${ext.always ? ', always' : ''}${reason}`,
					);
				}
				return;
			}
			case 'install': {
				const offered = (await listed()).extensions
					.filter((ext) => !ext.always && ext.status === 'available')
					.map((ext) => ext.id);
				const wanted = allOffered ? offered : ids;
				if (wanted.length === 0 && !allOffered)
					throw new Error('Usage: famos extensions install <id…> | <file.famext…> | --all-offered');
				const changed = new Set<string>();
				for (const arg of wanted) {
					const result = await run('core.installExtension', await installInput(arg));
					for (const done of result.changed) changed.add(done);
				}
				console.log(
					changed.size > 0
						? `Installed ${[...changed].join(', ')}. Restart FamilyOS to load them.`
						: 'Nothing to install.',
				);
				return;
			}
			case 'uninstall': {
				const [id] = ids;
				if (!id || ids.length > 1) throw new Error('Usage: famos extensions uninstall <id>');
				await run('core.uninstallExtension', { extensionId: id });
				console.log(`Uninstalled ${id}; its data is kept. Restart FamilyOS to apply.`);
				return;
			}
			case 'purge': {
				const [id] = ids;
				if (!id || ids.length > 1) throw new Error('Usage: famos extensions purge <id> [--yes]');
				const target = purgeTarget(id, {
					state: await readExtensionState(runtime.handle.db),
					installed: selection.installed,
					loaded: kernel.registry.extensions.map((ext) => ext.id),
					packages: selection.packages.list(),
				});
				const preview = await previewPurge(runtime.handle.db, target, runtime.config.filesDir);
				console.log(
					`This removes everything ${id} stored, for good: ${preview.tables.length} table(s) (${target.tablePrefix}…), ${preview.files} file(s), and what FamilyOS keeps about it (its jobs, drafts, notifications, permissions and settings). A backup is written first.`,
				);
				if (!flags.yes) {
					if (!process.stdin.isTTY)
						throw new Error('Nothing was removed. Add --yes to purge without being asked.');
					const answer = await askLine(`Type ${id} to remove its data: `);
					if (answer.trim() !== id) {
						console.log('Nothing was removed.');
						return;
					}
				}
				const { path } = await backupNow(runtime, 'manual');
				console.log(`Backup written: ${path}`);
				const summary = await purgeExtension(runtime.handle, target, {
					filesDir: runtime.config.filesDir,
					now: Date.now(),
				});
				for (const line of describePurge(id, summary)) console.log(line);
				return;
			}
			default:
				throw new Error(
					'Usage: famos extensions list|install <id…> | --all-offered|uninstall <id>|purge <id>',
				);
		}
	} finally {
		await runtime.close();
	}
}

async function main() {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			force: { type: 'boolean' },
			help: { type: 'boolean' },
			identity: { type: 'string' },
			extensions: { type: 'string' },
			'all-offered': { type: 'boolean' },
			yes: { type: 'boolean' },
		},
	});
	const [command = 'serve', arg] = positionals;
	if (values.help) {
		console.log(USAGE);
		return;
	}

	// Before any outbound connection of any command (backup upload, extension install, serve).
	const distrust = distrustCertificates();
	switch (command) {
		case 'serve':
			return serveCommand(distrust);
		case 'migrate': {
			const { runtime } = await openWithExtensions(await loadConfig());
			const applied = await migrate(runtime);
			console.log(applied ? `Applied ${applied} migration(s).` : 'Database is up to date.');
			return runtime.close();
		}
		case 'backup': {
			const { runtime } = await openWithExtensions(await loadConfig());
			const { path } = await backupNow(runtime, 'manual');
			console.log(`Backup written: ${path}`);
			console.log('Uploads to remote targets (if any) are sent by the running server.');
			return runtime.close();
		}
		case 'extensions':
			return extensionsCommand(arg, positionals.slice(2), {
				allOffered: values['all-offered'] === true,
				yes: values.yes === true,
			});
		case 'restore': {
			if (!arg) throw new Error('Usage: famos restore <file> [--identity <file>] [--force]');
			const config = await loadConfig();
			const { extensions } = await loadExtensions();
			const manifest = await restoreFile(config, arg, {
				extensions,
				...(values.force && { force: true }),
				...(values.identity && { identity: values.identity }),
				passphrase: process.env.FAMOS_BACKUP_PASSPHRASE,
				askPassphrase: () => askSecret('Backup passphrase: '),
			});
			console.log(
				`Restored backup from ${manifest.createdAt} (FamilyOS ${manifest.appVersion}). Previous data was kept as *.pre-restore-*. At the next start everyone signs in again, and keys, devices, members and passwords changed after the backup stay changed.`,
			);
			return;
		}
		case 'openapi': {
			const out = arg ?? 'openapi.json';
			// Generation needs the registry only: in-memory database, no data directory.
			const { extensions } = await loadExtensions();
			const runtime = openRuntime(generationConfig(), {
				extensions,
				logger: silentLogger,
				quiet: true,
			});
			const app = createHttpApp({
				kernel: runtime.kernel,
				ai: runtime.ai,
				webPush: runtime.webPush,
				telegram: runtime.telegram,
				email: runtime.email,
				backups: runtime.backups,
				backupsDir: '/nonexistent/backups',
				backupSchedule: { hour: 3, keep: 7 },
				identity: runtime.identity,
				knownDevices: runtime.knownDevices,
				logger: runtime.logger,
				trustedOrigins: [],
				appVersion: APP_VERSION,
				secureCookies: false,
			});
			const doc = app.getOpenAPI31Document(OPENAPI_INFO);
			await runtime.close();
			if (!values.extensions) {
				await writeJson(out, doc);
				console.log(`OpenAPI document written: ${out}`);
				return;
			}
			const split = splitOpenApi(
				doc,
				extensions.map((ext) => ext.id),
			);
			await writeJson(out, split.host);
			for (const [id, fragment] of split.extensions) {
				const dir = join(values.extensions, id);
				await access(join(dir, 'package.json')).catch(() => {
					throw new Error(`No extension package for ${id} at ${dir}`);
				});
				await writeJson(join(dir, 'openapi.json'), fragment);
			}
			console.log(`OpenAPI documents written: ${out} and ${split.extensions.size} extension(s)`);
			return;
		}
		case 'public-openapi': {
			const out = arg ?? 'public-openapi.json';
			const { extensions } = await loadExtensions();
			const runtime = openRuntime(generationConfig(), {
				extensions,
				logger: silentLogger,
				quiet: true,
			});
			const doc = publicOpenApiDocument({
				kernel: runtime.kernel,
				logger: runtime.logger,
				appVersion: APP_VERSION,
				clientIp: () => '127.0.0.1',
			});
			await runtime.close();
			await writeJson(out, doc);
			console.log(`Public OpenAPI document written: ${out}`);
			return;
		}
		default:
			console.error(USAGE);
			process.exit(2);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
