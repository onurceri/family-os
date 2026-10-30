import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import type { CoreTables } from '@famos/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const BASE = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';
const NAME = 'famos-20261030-101500-manual.tar';
const PATH = (name: string) => `/api/v1/backups/local/${encodeURIComponent(name)}`;
let bytes: Buffer;
let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;
let dataDir: string;
let ip = 0;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'famos-backup-download-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
		extensions,
	});
	await migrate(runtime);
	await runtime.kernel.start();
	// Bigger than one stream chunk, so the answer is really read from the file in pieces.
	bytes = randomBytes(300_000);
	await mkdir(runtime.config.backupsDir, { recursive: true });
	await writeFile(join(runtime.config.backupsDir, NAME), bytes);
	await writeFile(join(runtime.config.backupsDir, 'famos-notes.txt'), 'not a backup');
	await writeFile(join(dataDir, 'famos-outside-manual.tar'), 'outside the backups folder');
	app = createHttpApp({
		kernel: runtime.kernel,
		ai: runtime.ai,
		webPush: runtime.webPush,
		telegram: runtime.telegram,
		email: runtime.email,
		backups: runtime.backups,
		backupsDir: runtime.config.backupsDir,
		backupSchedule: runtime.config.backup,
		keyFile: runtime.config.secret,
		identity: runtime.identity,
		knownDevices: runtime.knownDevices,
		logger: silentLogger,
		trustedOrigins: [BASE],
		appVersion: APP_VERSION,
		secureCookies: false,
		trustedProxies: ['127.0.0.1'],
	});
});
afterEach(() => runtime.close());

async function call(
	method: string,
	path: string,
	body?: unknown,
	cookie?: string,
	extra: { headers?: Record<string, string>; address?: string } = {},
) {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			'x-forwarded-for': extra.address ?? `10.7.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`,
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(cookie && { cookie }),
			...extra.headers,
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const raw = Buffer.from(await res.arrayBuffer());
	const text = raw.toString('utf8');
	return {
		raw,
		status: res.status,
		headers: res.headers,
		text,
		body: text.startsWith('{') ? JSON.parse(text) : null,
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

async function signIn(email: string, password: string) {
	const res = await call('POST', '/api/auth/sign-in/email', { email, password });
	expect(res.status).toBe(200);
	return res.cookie;
}

async function admin() {
	const setup = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: PASSWORD,
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	expect(setup.status).toBe(201);
	return signIn('parent@example.com', PASSWORD);
}

const auditRows = () =>
	runtime.kernel.ctx.db
		.withTables<CoreTables>()
		.selectFrom('core_audit_log')
		.select(['action_id', 'actor', 'target'])
		.where('action_id', '=', 'core.downloadBackup')
		.execute();

async function member(cookie: string, displayName: string, roleId: string) {
	return (await call('POST', '/api/v1/actions/core.createMember', { displayName, roleId }, cookie))
		.body.output as { id: string };
}

describe('Downloading a local backup', () => {
	it('streams the file to an admin at a password sign-in, as a download, and audits it', async () => {
		const cookie = await admin();
		const listed = await call('GET', '/api/v1/backups', undefined, cookie);
		expect(listed.body.local.map((b: { name: string }) => b.name)).toEqual([NAME]);

		const res = await call('GET', PATH(NAME), undefined, cookie);
		expect(res.status).toBe(200);
		expect(res.raw.equals(bytes)).toBe(true);
		expect(res.headers.get('content-type')).toBe('application/x-tar');
		expect(res.headers.get('content-length')).toBe(String(bytes.length));
		expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${NAME}"`);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');

		const rows = await auditRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.target).toBe(NAME);
	});

	it('refuses names that are not a backup in the folder, without saying more', async () => {
		const cookie = await admin();
		for (const name of [
			'../x',
			'../famos-outside-manual.tar',
			'..%2Ffamos-outside-manual.tar',
			'famos-x.txt',
			'famos-notes.txt',
			'famos-20200101-000000-manual.tar',
			'famos-..-manual.tar',
		]) {
			const res = await call('GET', `/api/v1/backups/local/${name}`, undefined, cookie);
			expect(res.status, name).toBe(404);
			expect(res.text).not.toContain('outside the backups folder');
		}
		expect(await auditRows()).toHaveLength(0);
	});

	it('is refused without a session, without the capability, and on a PIN sign-in', async () => {
		const cookie = await admin();
		expect((await call('GET', PATH(NAME))).status).toBe(401);

		const aunt = await member(cookie, 'Aunt', 'member');
		await call(
			'PUT',
			`/api/v1/core/members/${aunt.id}/password`,
			{ password: 'another horse battery', email: 'aunt@example.com' },
			cookie,
		);
		const auntCookie = await signIn('aunt@example.com', 'another horse battery');
		const refused = await call('GET', PATH(NAME), undefined, auntCookie);
		expect(refused.status).toBe(403);
		expect(refused.raw.includes(bytes.subarray(0, 64))).toBe(false);

		// An admin on a PIN is not at a password sign-in, so the settings stay out of reach.
		const other = await member(cookie, 'Other admin', 'admin');
		await call('PUT', `/api/v1/core/members/${other.id}/pin`, { pin: '2468' }, cookie);
		const device = await call('POST', '/api/v1/core/devices/trust', { name: 'Tablet' }, cookie);
		const pin = await call(
			'POST',
			'/api/auth/sign-in/pin',
			{ memberId: other.id, pin: '2468' },
			device.cookie,
		);
		expect(pin.status).toBe(200);
		const onPin = await call('GET', PATH(NAME), undefined, pin.cookie);
		expect(onPin.status).toBe(403);
		expect(onPin.raw.includes(bytes.subarray(0, 64))).toBe(false);
		expect(await auditRows()).toHaveLength(0);
	});
});
