import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirMailbox } from '@famos/adapters/email';
import type { Logger } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';

const BASE = 'http://localhost:3000';
const PASSWORD = 'mailbox app password 4711';
/** SOI, an EXIF segment holding "GPS", EOI: the Inbox must strip the metadata. */
const PHOTO = Uint8Array.from([
	0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0b, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x47, 0x50, 0x53, 0xff, 0xd9,
]);
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');

let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;
let mailDir: string;
let logs: string[];
let responses: string[];
let cookie: string;
let ip = 0;

const capturingLogger = (): Logger => {
	const write = (obj: object, msg?: string) => logs.push(JSON.stringify({ obj, msg }));
	const logger: Logger = {
		debug: write,
		info: write,
		warn: write,
		error: write,
		child: (bindings) => {
			logs.push(JSON.stringify(bindings));
			return logger;
		},
	};
	return logger;
};

async function call(method: string, path: string, body?: unknown, withCookie = cookie) {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			'x-forwarded-for': `10.3.0.${++ip}`,
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(withCookie && { cookie: withCookie }),
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

const settings = {
	host: 'imap.family.example',
	port: 993,
	username: 'inbox@family.example',
	password: PASSWORD,
	mailbox: 'INBOX',
	processedFolder: 'FamilyOS',
	pollMinutes: 5,
	enabled: true,
};

function eml(from: string, subject: string, id: string) {
	const b = 'BND';
	const part = (type: string, name: string, data: Uint8Array) =>
		[
			`--${b}`,
			`Content-Type: ${type}; name="${name}"`,
			'Content-Transfer-Encoding: base64',
			`Content-Disposition: attachment; filename="${name}"`,
			'',
			Buffer.from(data).toString('base64'),
		].join('\r\n');
	return [
		`From: ${from}`,
		'To: inbox@family.example',
		`Subject: ${subject}`,
		`Message-ID: <${id}@x>`,
		'MIME-Version: 1.0',
		`Content-Type: multipart/mixed; boundary="${b}"`,
		'',
		`--${b}`,
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Parents evening is on 12 November at 18:00.',
		part('image/jpeg', 'photo.jpg', PHOTO),
		part('application/pdf', 'invite.pdf', PDF),
		`--${b}--`,
		'',
	].join('\r\n');
}

beforeEach(async () => {
	logs = [];
	responses = [];
	mailDir = await mkdtemp(join(tmpdir(), 'famos-email-mail-'));
	await mkdir(join(mailDir, 'INBOX'));
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-email-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		logger: capturingLogger(),
		quiet: true,
		passwordHasher: fastPasswordHasher,
		emailConnect: createDirMailbox(mailDir),
	});
	await migrate(runtime);
	await runtime.kernel.start();
	app = createHttpApp({
		kernel: runtime.kernel,
		ai: runtime.ai,
		webPush: runtime.webPush,
		telegram: runtime.telegram,
		email: runtime.email,
		backups: runtime.backups,
		backupsDir: runtime.config.backupsDir,
		backupSchedule: runtime.config.backup,
		identity: runtime.identity,
		logger: runtime.logger,
		trustedOrigins: [BASE],
		appVersion: APP_VERSION,
		secureCookies: false,
		trustedProxies: ['127.0.0.1'],
	});
	const setup = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: 'correct horse battery',
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	expect(setup.status).toBe(201);
	cookie = (
		await call('POST', '/api/auth/sign-in/email', {
			email: 'parent@example.com',
			password: 'correct horse battery',
		})
	).cookie;
});

afterEach(async () => {
	runtime.email.stop();
	await runtime.close();
});

describe('email settings', () => {
	it('is for admins only and never returns or logs the password', async () => {
		expect((await call('GET', '/api/v1/email/settings', undefined, '')).status).toBe(401);
		expect((await call('GET', '/api/v1/email/settings')).body).toMatchObject({
			configured: false,
			state: 'off',
		});

		const kid = (
			await call('POST', '/api/v1/actions/core.createMember', {
				displayName: 'Kid',
				roleId: 'supervised',
			})
		).body.output.id as string;
		await call('PUT', `/api/v1/core/members/${kid}/pin`, { pin: '2468' });
		const device = await call('POST', '/api/v1/core/devices/trust', { name: 'Tablet' });
		const kidCookie = (
			await call('POST', '/api/auth/sign-in/pin', { memberId: kid, pin: '2468' }, device.cookie)
		).cookie;
		expect((await call('GET', '/api/v1/email/available', undefined, '')).status).toBe(401);
		expect((await call('GET', '/api/v1/email/available', undefined, kidCookie)).body).toEqual({
			available: false,
		});
		for (const [method, path, body] of [
			['GET', '/api/v1/email/settings', undefined],
			['PUT', '/api/v1/email/settings', settings],
			['DELETE', '/api/v1/email/settings', undefined],
			['GET', '/api/v1/email/senders', undefined],
			['POST', '/api/v1/email/senders', { address: 'a@b.example', memberId: kid }],
			['DELETE', '/api/v1/email/senders/a%40b.example', undefined],
			['POST', '/api/v1/email/check', undefined],
		] as const)
			expect((await call(method, path, body, kidCookie)).status, `${method} ${path}`).toBe(403);

		const saved = await call('PUT', '/api/v1/email/settings', settings);
		expect(saved.status).toBe(200);
		expect(saved.body.test).toEqual({ ok: true, code: 'ok' });
		expect(saved.body.settings).toMatchObject({
			configured: true,
			hasPassword: true,
			host: 'imap.family.example',
			state: 'ok',
		});
		expect(Object.keys(saved.body.settings)).not.toContain('password');
		// Every member may know that mail reaches Quick add, and nothing else.
		expect((await call('GET', '/api/v1/email/available', undefined, kidCookie)).body).toEqual({
			available: true,
		});

		// Saving again without a password keeps the stored one.
		const { password: _omit, ...withoutPassword } = settings;
		const again = await call('PUT', '/api/v1/email/settings', {
			...withoutPassword,
			pollMinutes: 10,
		});
		expect(again.body.test.ok).toBe(true);

		expect(responses.join('\n')).not.toContain(PASSWORD);
		expect(logs.join('\n')).not.toContain(PASSWORD);
		// Not in the database in the clear either.
		const stored = await runtime.handle.sqlite.prepare('select password from email_settings').get();
		expect(JSON.stringify(stored)).not.toContain(PASSWORD);
	});

	it('refuses a wrong password and an unknown mailbox with a code, and stays off', async () => {
		const wrong = await call('PUT', '/api/v1/email/settings', {
			...settings,
			password: 'wrong-password',
		});
		expect(wrong.status).toBe(200);
		expect(wrong.body.test).toEqual({ ok: false, code: 'auth_failed' });
		expect(wrong.body.settings).toMatchObject({ enabled: false, state: 'auth_failed' });
		const missing = await call('PUT', '/api/v1/email/settings', { ...settings, mailbox: 'Nope' });
		expect(missing.body.test.code).toBe('mailbox_missing');
		const noPassword = await call('PUT', '/api/v1/email/settings', {
			...settings,
			password: undefined,
		});
		// (a password was stored by the failed attempts, so this is accepted)
		expect(noPassword.status).toBe(200);
		expect(
			(await call('PUT', '/api/v1/email/settings', { ...settings, pollMinutes: 1 })).status,
		).toBe(400);
	});

	it('manages allowed senders and only for real members', async () => {
		const me = (await call('GET', '/api/v1/core/me')).body.id as string;
		const added = await call('POST', '/api/v1/email/senders', {
			address: ' Office@School.EXAMPLE ',
			memberId: me,
			label: 'School',
		});
		expect(added.body).toEqual({ address: 'office@school.example', memberId: me, label: 'School' });
		expect(
			(
				await call('POST', '/api/v1/email/senders', {
					address: 'x@y.example',
					memberId: 'mem_nope',
				})
			).status,
		).toBe(400);
		expect(
			(await call('POST', '/api/v1/email/senders', { address: 'not-an-address', memberId: me }))
				.status,
		).toBe(400);
		expect((await call('GET', '/api/v1/email/senders')).body).toHaveLength(1);
		expect((await call('DELETE', '/api/v1/email/senders/Office%40school.example')).status).toBe(
			200,
		);
		expect((await call('GET', '/api/v1/email/senders')).body).toEqual([]);
	});
});

describe('reading the mailbox', () => {
	it('"Check now" queues a job that adds allowed mail to the Inbox as the member', async () => {
		const me = (await call('GET', '/api/v1/core/me')).body.id as string;
		await call('PUT', '/api/v1/email/settings', settings);
		await call('POST', '/api/v1/email/senders', { address: 'school@school.example', memberId: me });
		await writeFile(
			join(mailDir, 'INBOX', '1.eml'),
			eml('School <school@school.example>', 'Parents evening', 'a'),
		);
		await writeFile(
			join(mailDir, 'INBOX', '2.eml'),
			eml('Spam <spam@evil.example>', 'You won', 'b'),
		);

		const check = await call('POST', '/api/v1/email/check');
		expect(check.status).toBe(202);
		// A second request while one is queued adds nothing.
		await call('POST', '/api/v1/email/check');
		await runtime.kernel.worker.drain();

		const items = (await call('GET', '/api/v1/inbox/items')).body;
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			channel: 'email',
			title: 'Parents evening',
			text: 'Parents evening is on 12 November at 18:00.',
			createdBy: me,
		});
		expect(items[0].files.map((f: { name: string; type: string }) => [f.name, f.type])).toEqual([
			['photo.jpg', 'image/jpeg'],
			['invite.pdf', 'application/pdf'],
		]);
		// Photo metadata is stripped like for any upload.
		const stored = await runtime.kernel.ctx.files.get(`inbox/${items[0].id}/0`);
		const chunks: Uint8Array[] = [];
		for await (const chunk of stored?.stream ?? []) chunks.push(chunk);
		expect(Buffer.concat(chunks).includes(Buffer.from('Exif'))).toBe(false);

		expect(await readdir(join(mailDir, 'INBOX'))).toEqual(['2.eml']);
		expect(await readdir(join(mailDir, 'FamilyOS'))).toEqual(['1.eml']);
		const status = (await call('GET', '/api/v1/email/settings')).body;
		expect(status).toMatchObject({ state: 'ok', processed: 1, unknownSenders: 1, failed: 0 });

		const text = logs.join('\n');
		for (const secret of [
			'Parents evening',
			'school@school.example',
			'spam@evil.example',
			PASSWORD,
		])
			expect(text).not.toContain(secret);
	});

	it('keeps mail waiting while the Inbox is off, then adds it', async () => {
		const me = (await call('GET', '/api/v1/core/me')).body.id as string;
		await call('PUT', '/api/v1/email/settings', settings);
		await call('POST', '/api/v1/email/senders', { address: 'school@school.example', memberId: me });
		await writeFile(join(mailDir, 'INBOX', '1.eml'), eml('school@school.example', 'Hello', 'c'));
		await call('POST', '/api/v1/actions/core.setFeatureEnabled', {
			extensionId: 'inbox',
			enabled: false,
		});
		await runtime.email.poll();
		expect((await call('GET', '/api/v1/email/settings')).body.failed).toBe(1);
		expect(await readdir(join(mailDir, 'INBOX'))).toEqual(['1.eml']);
		await call('POST', '/api/v1/actions/core.setFeatureEnabled', {
			extensionId: 'inbox',
			enabled: true,
		});
		await runtime.email.poll();
		expect(await readdir(join(mailDir, 'INBOX'))).toEqual([]);
		expect((await call('GET', '/api/v1/inbox/items')).body).toHaveLength(1);
	});
});
