import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DecryptError, encryptStream } from '@famos/adapters/backup';
import { silentLogger } from '@famos/adapters/runtime';
import type { CoreTables } from '@famos/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { restoreFile } from '../src/restore.ts';
import { backupNow, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const BASE = 'http://localhost:3000';
const PASSPHRASE = 'a long family passphrase';
const DAV_PASSWORD = 'dav-app-password-42';

let config: Config;
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;
let dav: { files: Map<string, Buffer>; status: number; close(): Promise<void>; url: string };
let responses: string[];
let ip = 0;

async function startDav() {
	const files = new Map<string, Buffer>();
	const state = { status: 0 };
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			if (state.status) return void res.writeHead(state.status).end();
			const name = decodeURIComponent((req.url ?? '').replace(/^\/dav\/?/, ''));
			if (req.method === 'PUT') files.set(name, Buffer.concat(chunks));
			if (req.method === 'DELETE') files.delete(name);
			if (req.method === 'PROPFIND') {
				const entries = [...files.keys()]
					.map((n) => `<d:response><d:href>/dav/${encodeURIComponent(n)}</d:href></d:response>`)
					.join('');
				return void res
					.writeHead(207)
					.end(`<d:multistatus xmlns:d="DAV:">${entries}</d:multistatus>`);
			}
			res.writeHead(req.method === 'MKCOL' ? 405 : 201).end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		files,
		get status() {
			return state.status;
		},
		set status(value: number) {
			state.status = value;
		},
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dav`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const open = () => {
	const r = openRuntime(config, {
		extensions,
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
		scryptWorkFactor: 10,
	});
	app = createHttpApp({
		kernel: r.kernel,
		ai: r.ai,
		webPush: r.webPush,
		telegram: r.telegram,
		email: r.email,
		backups: r.backups,
		backupsDir: r.config.backupsDir,
		backupSchedule: r.config.backup,
		identity: r.identity,
		logger: silentLogger,
		trustedOrigins: [BASE],
		appVersion: '0.0.0-test',
		secureCookies: false,
		trustedProxies: ['127.0.0.1'],
	});
	return r;
};

beforeEach(async () => {
	responses = [];
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-backups-'));
	config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = open();
	await migrate(runtime);
	await runtime.kernel.start();
	dav = await startDav();
});
afterEach(async () => {
	await runtime.close();
	await dav.close();
});

async function call(method: string, path: string, body?: unknown, cookie?: string) {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			'x-forwarded-for': `10.4.0.${++ip}`,
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(cookie && { cookie }),
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	responses.push(text);
	return {
		status: res.status,
		body: text ? JSON.parse(text) : null,
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

async function admin() {
	await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: 'correct horse battery',
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	return (
		await call('POST', '/api/auth/sign-in/email', {
			email: 'parent@example.com',
			password: 'correct horse battery',
		})
	).cookie;
}

const webdav = (password = DAV_PASSWORD) => ({
	kind: 'webdav',
	name: 'Nextcloud',
	keep: 2,
	config: { url: dav.url, username: 'anna', password },
});

describe('Backups API', () => {
	it('is for admins only', async () => {
		const cookie = await admin();
		expect((await call('GET', '/api/v1/backups')).status).toBe(401);
		const created = await call(
			'POST',
			'/api/v1/actions/core.createMember',
			{ displayName: 'Aunt', roleId: 'member' },
			cookie,
		);
		const password = { password: 'another horse battery', email: 'aunt@example.com' };
		expect(
			(
				await call(
					'PUT',
					`/api/v1/core/members/${created.body.output.id}/password`,
					password,
					cookie,
				)
			).status,
		).toBe(200);
		const aunt = (
			await call('POST', '/api/auth/sign-in/email', {
				email: password.email,
				password: password.password,
			})
		).cookie;
		for (const [method, path] of [
			['GET', '/api/v1/backups'],
			['POST', '/api/v1/backups/run'],
			['POST', '/api/v1/backups/targets/x/test'],
		] as const)
			expect((await call(method, path, undefined, aunt)).status).toBe(403);
		expect((await call('PUT', '/api/v1/backups/encryption', { mode: 'none' }, aunt)).status).toBe(
			403,
		);
		expect((await call('GET', '/api/v1/backups', undefined, cookie)).status).toBe(200);
	});

	it('writes a backup in the background, sends it encrypted, and never shows a secret', async () => {
		const cookie = await admin();
		const start = await call('GET', '/api/v1/backups', undefined, cookie);
		expect(start.body).toMatchObject({
			local: [],
			targets: [],
			encryption: { mode: 'unset', recipient: null },
			schedule: { hour: 3, keep: 7 },
		});

		expect(
			(
				await call(
					'PUT',
					'/api/v1/backups/encryption',
					{ mode: 'passphrase', passphrase: 'short' },
					cookie,
				)
			).status,
		).toBe(400);
		expect(
			(
				await call(
					'PUT',
					'/api/v1/backups/encryption',
					{ mode: 'recipient', recipient: 'age1not-a-key-at-all' },
					cookie,
				)
			).status,
		).toBe(400);
		const enc = await call(
			'PUT',
			'/api/v1/backups/encryption',
			{ mode: 'passphrase', passphrase: PASSPHRASE },
			cookie,
		);
		expect(enc.body).toEqual({ mode: 'passphrase', recipient: null });

		const created = await call('POST', '/api/v1/backups/targets', webdav(), cookie);
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({
			kind: 'webdav',
			enabled: true,
			summary: { url: dav.url, username: 'anna' },
		});
		const id = created.body.id as string;
		expect(
			(await call('POST', `/api/v1/backups/targets/${id}/test`, undefined, cookie)).body,
		).toEqual({
			ok: true,
			code: 'ok',
		});

		// "Back up now" only queues; the worker writes the backup and then the upload.
		expect((await call('POST', '/api/v1/backups/run', undefined, cookie)).status).toBe(202);
		expect(await readdir(config.backupsDir).catch(() => [])).toEqual([]);
		await runtime.kernel.worker.drain();

		const after = await call('GET', '/api/v1/backups', undefined, cookie);
		expect(after.body.local).toHaveLength(1);
		expect(after.body.local[0]).toMatchObject({ reason: 'manual' });
		expect(after.body.targets[0]).toMatchObject({ lastResult: 'ok' });
		const [remote] = [...dav.files.keys()];
		expect(remote).toBe(`${after.body.local[0].name}.age`);
		expect(
			dav.files
				.get(remote ?? '')
				?.subarray(0, 21)
				.toString(),
		).toBe('age-encryption.org/v1');

		const patched = await call(
			'PATCH',
			`/api/v1/backups/targets/${id}`,
			{ enabled: false },
			cookie,
		);
		expect(patched.body).toMatchObject({ enabled: false });
		expect((await call('DELETE', `/api/v1/backups/targets/${id}`, undefined, cookie)).status).toBe(
			200,
		);
		expect((await call('GET', '/api/v1/backups', undefined, cookie)).body.targets).toEqual([]);

		for (const text of responses) {
			expect(text).not.toContain(DAV_PASSWORD);
			expect(text).not.toContain(PASSPHRASE);
		}
	});

	it('tells the admins when the upload finally fails', async () => {
		const cookie = await admin();
		await call('PUT', '/api/v1/backups/encryption', { mode: 'none' }, cookie);
		dav.status = 401;
		const created = await call('POST', '/api/v1/backups/targets', webdav(), cookie);
		await call('POST', '/api/v1/backups/run', undefined, cookie);
		await runtime.kernel.worker.drain();
		const list = await call('GET', '/api/v1/backups', undefined, cookie);
		expect(list.body.targets[0]).toMatchObject({ id: created.body.id, lastResult: 'http_401' });
		const rows = await runtime.kernel.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_notifications')
			.selectAll()
			.where('kind', '=', 'core.backupFailed')
			.execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.url).toBe('/settings/backups');
		expect(JSON.stringify(rows)).not.toContain(DAV_PASSWORD);
	});
});

describe('restoring an encrypted backup', () => {
	async function encryptedBackup(passphrase: string) {
		const { path } = await backupNow(runtime, 'manual');
		const out = `${path}.age`;
		const { stream, size } = await encryptStream(
			Readable.toWeb(
				Readable.from([await (await import('node:fs/promises')).readFile(path)]),
			) as ReadableStream<Uint8Array>,
			(await (await import('node:fs/promises')).stat(path)).size,
			{ mode: 'passphrase', passphrase },
			10,
		);
		const bytes = Buffer.from(await new Response(stream).arrayBuffer());
		expect(bytes.length).toBe(size);
		await writeFile(out, bytes);
		return out;
	}

	it('decrypts with the passphrase and brings the data back; a wrong one changes nothing', async () => {
		const cookie = await admin();
		const file = await encryptedBackup(PASSPHRASE);
		await call(
			'POST',
			'/api/v1/actions/core.createMember',
			{ displayName: 'Later', roleId: 'supervised' },
			cookie,
		);
		const names = async (r: Runtime) =>
			(await r.kernel.ctx.family.members()).map((m) => m.displayName);
		expect(await names(runtime)).toHaveLength(2);
		await runtime.close();

		await expect(
			restoreFile(config, file, { extensions, passphrase: 'not the right passphrase' }),
		).rejects.toBeInstanceOf(DecryptError);
		await expect(restoreFile(config, file, { extensions })).rejects.toThrow(/encrypted/);
		runtime = open();
		expect(await names(runtime)).toHaveLength(2);
		await runtime.close();

		const manifest = await restoreFile(config, file, { extensions, passphrase: PASSPHRASE });
		expect(manifest.reason).toBe('manual');
		runtime = open();
		expect(await names(runtime)).toEqual(['Parent']);
		// The temporary plain copy is gone.
		expect((await readdir(config.dataDir)).filter((n) => n.startsWith('.restore-'))).toEqual([]);
	});
});
