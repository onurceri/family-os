import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import { silentLogger } from '@famos/adapters/runtime';
import type { CoreTables } from '@famos/core';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { type Config, loadConfig } from './config.ts';
import { type LoadedExtensions, loadExtensions } from './extensions/load.ts';
import { createHttpApp, loadedWeb, OPENAPI_INFO, resolveActor } from './http/app.ts';
import { createRealtimeHub } from './http/realtime.ts';
import { mountSpa } from './http/static.ts';
import { splitOpenApi } from './openapi.ts';
import { askSecret } from './prompt.ts';
import { restoreFile } from './restore.ts';
import {
	APP_VERSION,
	backupNow,
	migrate,
	openRuntime,
	type Runtime,
	seedAi,
	startScheduler,
} from './runtime.ts';

const USAGE = `famos ${APP_VERSION}

Usage: famos <command>

  serve              Migrate (with automatic backup) and start the server (default)
  migrate            Apply pending migrations and exit
  backup             Write a backup to $FAMOS_DATA_DIR/backups and exit
  restore <file>     Restore a backup (stop the server first). An encrypted .age file asks
                     for its passphrase (or FAMOS_BACKUP_PASSPHRASE), or use --identity <file>
  openapi [file]     Write the OpenAPI document (default: openapi.json). With --extensions <dir>,
                     the file holds core's and the app's routes, and each extension's routes and
                     actions go to <dir>/<id>/openapi.json
`;

async function serveCommand() {
	const config = await loadConfig();
	const { runtime, web } = await openWithExtensions(config);
	const { logger, kernel } = runtime;
	const extensions = loadedWeb(kernel, web);
	await migrate(runtime);
	await seedAi(runtime);
	await kernel.start();
	await announceSetup(runtime);

	const stops: (() => void | Promise<void>)[] = [];
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
			identity: runtime.identity,
			logger,
			trustedOrigins: config.trustedOrigins,
			appVersion: APP_VERSION,
			secureCookies: config.baseURL.startsWith('https://'),
			trustedProxies: config.trustedProxies,
			extensions,
		});
		const hub = createRealtimeHub(kernel.bus, logger);
		app.get(
			'/api/v1/ws',
			async (c, next) => {
				// Same rules as the API: archived members, stale PIN sessions and revoked displays are refused.
				if (!(await resolveActor(kernel, runtime.identity, c.req.raw.headers)))
					return c.json({ error: { code: 'unauthenticated', message: 'Sign in required' } }, 401);
				return next();
			},
			upgradeWebSocket((c) => {
				const actor = c.get('actor');
				return hub.events(
					actor?.kind === 'display' ? actor.deviceId : null,
					actor?.kind === 'member' ? actor.memberId : null,
				);
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
			() =>
				new Promise<void>((resolve) => {
					// Open WebSockets and idle keep-alive connections would hold `close` open forever.
					server.close(() => resolve());
					if ('closeAllConnections' in server) server.closeAllConnections();
					for (const socket of upgraded) socket.destroy();
					for (const socket of sockets.clients) socket.terminate();
				}),
		);
	}

	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		logger.info({ signal }, 'shutting down');
		for (const stop of stops.reverse()) await stop();
		await runtime.close();
		process.exit(0);
	};
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));
}

/** Loads the extensions, then opens the runtime with them and says in the log what it runs. */
async function openWithExtensions(
	config: Config,
): Promise<{ runtime: Runtime; web: LoadedExtensions['web'] }> {
	const { extensions, web, report } = await loadExtensions();
	const runtime = openRuntime(config, { extensions });
	logLoaded(runtime, report);
	return { runtime, web };
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

async function main() {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			force: { type: 'boolean' },
			help: { type: 'boolean' },
			identity: { type: 'string' },
			extensions: { type: 'string' },
		},
	});
	const [command = 'serve', arg] = positionals;
	if (values.help) {
		console.log(USAGE);
		return;
	}

	switch (command) {
		case 'serve':
			return serveCommand();
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
				`Restored backup from ${manifest.createdAt} (FamilyOS ${manifest.appVersion}). Previous data was kept as *.pre-restore-*.`,
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
		default:
			console.error(USAGE);
			process.exit(2);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
