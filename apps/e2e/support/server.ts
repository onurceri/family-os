import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
// The image's entry point: the supervisor, which starts the server again when it asks to.
const SERVER = join(ROOT, 'apps/server/dist/famos.mjs');
const WEB = join(ROOT, 'apps/web/build');
export const SETUP_CODE = 'e2e-setup-code';

/**
 * Each Playwright worker takes ports from its own block below the ephemeral range (from 32768 on
 * Linux, 49152 on macOS). A port the system hands out is free only until it is closed again, and in
 * the moment before the server listens it can go to another worker, a fake service or an outgoing
 * connection; a block of its own leaves the worker nobody to share it with.
 */
const PORTS_PER_WORKER = 400;
let nextPort = 20_000 + Number(process.env.TEST_PARALLEL_INDEX ?? 0) * PORTS_PER_WORKER;

function isFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once('error', () => done(false));
		probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
	});
}

async function freePort(): Promise<number> {
	for (let tries = 0; tries < PORTS_PER_WORKER; tries++) {
		const port = nextPort++;
		if (await isFree(port)) return port;
	}
	throw new Error("No free port left in this worker's block");
}

/**
 * Runs the production bundle (`pnpm build`) on a data directory (a fresh one unless `dataDir` is
 * given), the way the Docker image does. `restart()` stops and starts it on the same data and
 * port, like an update or a reboot; `close()` also removes the data directory.
 */
export async function startFamilyOS(options: {
	modelUrl: string;
	telegramApiRoot?: string;
	emailFakeDir?: string;
	dataDir?: string;
	/** Believe `X-Forwarded-For` from this machine, so a test can send requests from other addresses. */
	behindProxy?: boolean;
}) {
	if (
		!existsSync(SERVER) ||
		!existsSync(join(WEB, 'index.html')) ||
		!existsSync(join(ROOT, 'dist/extensions/extensions.json'))
	)
		throw new Error('Build first: pnpm build (E2E runs the production bundle)');
	const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'famos-e2e-')));
	const port = await freePort();
	const url = `http://localhost:${port}`;
	const env = {
		...process.env,
		// The test-only settings below are refused under production, whatever the shell has set.
		NODE_ENV: 'test',
		FAMOS_DATA_DIR: dataDir,
		FAMOS_WEB_DIR: WEB,
		FAMOS_BASE_URL: url,
		FAMOS_SETUP_CODE: SETUP_CODE,
		// FAMOS_E2E_HOST=0.0.0.0 lets a sandbox reach the server (sweep/readme-agent-server.spec.ts).
		HOST: process.env.FAMOS_E2E_HOST ?? '127.0.0.1',
		PORT: String(port),
		LOG_LEVEL: process.env.FAMOS_E2E_LOG ? 'info' : 'warn',
		FAMOS_AI_PROVIDER: 'openai-compatible',
		FAMOS_AI_BASE_URL: options.modelUrl,
		FAMOS_AI_MODEL: 'fake',
		// Suggestions notify after 30 s in production; a short delay keeps specs fast.
		FAMOS_NOTIFY_DELAY_MS: '500',
		...(options.telegramApiRoot && { FAMOS_TELEGRAM_API_ROOT: options.telegramApiRoot }),
		...(options.emailFakeDir && { FAMOS_EMAIL_FAKE_DIR: options.emailFakeDir }),
		...(options.behindProxy && { FAMOS_TRUSTED_PROXIES: '127.0.0.1' }),
		// A container reaches a server on every interface by this name (old-browser/serve.spec.ts).
		...(process.env.FAMOS_E2E_HOST && {
			FAMOS_TRUSTED_ORIGINS: `http://host.docker.internal:${port}`,
		}),
	} as NodeJS.ProcessEnv;

	let child: ChildProcess | undefined;
	let output = '';
	async function start() {
		output = '';
		child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout?.on('data', (d) => (output += d));
		child.stderr?.on('data', (d) => (output += d));
		for (let i = 0; i < 300; i++) {
			if (child.exitCode !== null) throw new Error(`FamilyOS exited:\n${output}`);
			try {
				if ((await fetch(`${url}/health`)).ok) return;
			} catch {
				// not listening yet
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`FamilyOS did not start:\n${output}`);
	}
	async function stop() {
		// FAMOS_E2E_LOG=1 prints what the server logged, for finding why a test failed.
		if (process.env.FAMOS_E2E_LOG) process.stderr.write(output);
		const running = child;
		if (!running || running.exitCode !== null) return;
		const exited = new Promise((r) => running.once('exit', r));
		running.kill('SIGTERM');
		await exited;
	}

	await start();
	return {
		url,
		dataDir,
		stop,
		start,
		/** Runs a CLI command of the bundle (`backup`, `restore <file>`) on the same data; stop the server first. */
		cli: (args: string[], extraEnv: Record<string, string> = {}) =>
			new Promise<{ code: number | null; output: string }>((done, fail) => {
				const proc = spawn(process.execPath, [SERVER, ...args], {
					env: { ...env, ...extraEnv },
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				let out = '';
				proc.stdout.on('data', (d) => (out += d));
				proc.stderr.on('data', (d) => (out += d));
				proc.once('error', fail);
				proc.once('exit', (code) => done({ code, output: out }));
			}),
		restart: async () => {
			await stop();
			await start();
		},
		close: async () => {
			await stop();
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}

export type FamilyOS = Awaited<ReturnType<typeof startFamilyOS>>;
