import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { defineRoute, FamosError, FileResponseSchema } from '@famos/sdk';
import { defineTestExtension } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';

const BASE = 'http://localhost:3000';

const download = defineRoute({
	method: 'get',
	path: '/files/{name}',
	operationId: 'probe.download',
	summary: 'Download a stored file',
	requires: 'signedIn',
	params: z.object({ name: z.string() }),
	response: FileResponseSchema,
	async handle(ctx, { params }) {
		const stored = await ctx.files.get(`probe/${params.name}`);
		if (!stored) throw new FamosError('not_found', 'No file');
		return {
			stream: stored.stream,
			contentType: stored.stat.contentType ?? 'application/octet-stream',
			size: stored.stat.size,
			filename: params.name,
		};
	},
});

const upload = defineRoute({
	method: 'post',
	path: '/items',
	operationId: 'probe.upload',
	summary: 'Upload files',
	requires: 'signedIn',
	upload: { maxBytes: 64 * 1024, maxFiles: 2, accept: ['image/*', 'text/plain'] },
	body: z.object({ note: z.string().min(1) }),
	response: z.object({
		note: z.string(),
		files: z.array(z.object({ name: z.string(), size: z.number() })),
	}),
	async handle(ctx, { body, files }) {
		for (const f of files) await ctx.files.put(`probe/${f.name}`, f.stream(), f.type);
		return { note: body.note, files: files.map((f) => ({ name: f.name, size: f.size })) };
	},
});

let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;
let cookie: string;
let ip = 0;

beforeEach(async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-upload-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
		extensions: [defineTestExtension({ id: 'probe', routes: [upload, download] })],
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
		logger: silentLogger,
		trustedOrigins: [BASE],
		appVersion: APP_VERSION,
		secureCookies: false,
		// In-process requests come from 127.0.0.1; each test call rotates X-Forwarded-For.
		trustedProxies: ['127.0.0.1'],
	});
	const json = (path: string, body: unknown) =>
		app.request(`${BASE}${path}`, {
			method: 'POST',
			// A fresh client address per test: sign-in is rate limited per IP.
			headers: {
				'content-type': 'application/json',
				origin: BASE,
				'x-forwarded-for': `10.2.0.${++ip}`,
			},
			body: JSON.stringify(body),
		});
	await json('/api/v1/core/setup', {
		displayName: 'P',
		email: 'p@example.com',
		password: 'correct horse battery',
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	const res = await json('/api/auth/sign-in/email', {
		email: 'p@example.com',
		password: 'correct horse battery',
	});
	cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.join('; ');
});
afterEach(() => runtime.close());

function send(form: FormData, withCookie = true) {
	return app.request(`${BASE}/api/v1/probe/items`, {
		method: 'POST',
		headers: { origin: BASE, ...(withCookie && { cookie }) },
		body: form,
	});
}
const file = (name: string, type: string, bytes = 10) =>
	new File([new Uint8Array(bytes)], name, { type });

describe('upload routes', () => {
	it('accepts files and validated fields, and stores them', async () => {
		const form = new FormData();
		form.append('note', 'school flyer');
		form.append('files', file('flyer.png', 'image/png', 2048));
		form.append('files', file('note.txt', 'text/plain'));
		const res = await send(form);
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({
			note: 'school flyer',
			files: [
				{ name: 'flyer.png', size: 2048 },
				{ name: 'note.txt', size: 10 },
			],
		});
		expect((await runtime.kernel.ctx.files.stat('probe/flyer.png'))?.size).toBe(2048);
	});

	it('rejects wrong types, too many files, missing fields and oversize bodies', async () => {
		const wrongType = new FormData();
		wrongType.append('note', 'x');
		wrongType.append('files', file('a.exe', 'application/x-msdownload'));
		expect((await send(wrongType)).status).toBe(400);

		const tooMany = new FormData();
		tooMany.append('note', 'x');
		for (const n of ['a', 'b', 'c']) tooMany.append('files', file(`${n}.png`, 'image/png'));
		expect((await send(tooMany)).status).toBe(400);

		const noNote = new FormData();
		noNote.append('files', file('a.png', 'image/png'));
		expect((await send(noNote)).status).toBe(400);

		const big = new FormData();
		big.append('note', 'x');
		big.append('files', file('big.png', 'image/png', 200 * 1024));
		expect((await send(big)).status).toBe(413);
	});

	it('requires a session and is documented in OpenAPI', async () => {
		const form = new FormData();
		form.append('note', 'x');
		expect((await send(form, false)).status).toBe(401);
		const doc = (await (await app.request(`${BASE}/api/openapi.json`)).json()) as {
			paths: Record<string, { post: { requestBody: { content: Record<string, unknown> } } }>;
		};
		const content = doc.paths['/api/v1/probe/items']?.post.requestBody.content ?? {};
		expect(Object.keys(content)).toEqual(['multipart/form-data']);
	});

	it('serves stored files sandboxed; only images render inline', async () => {
		const form = new FormData();
		form.append('note', 'x');
		form.append('files', file('photo.png', 'image/png'));
		form.append(
			'files',
			new File(['<svg onload="alert(1)"/>'], 'evil.txt', { type: 'text/plain' }),
		);
		expect((await send(form)).status).toBe(201);
		const get = (name: string) =>
			app.request(`${BASE}/api/v1/probe/files/${name}`, { headers: { cookie } });

		const photo = await get('photo.png');
		expect(photo.status).toBe(200);
		expect(photo.headers.get('content-type')).toBe('image/png');
		expect(photo.headers.get('content-disposition')).toMatch(/^inline/);
		expect(photo.headers.get('content-security-policy')).toMatch(/sandbox/);
		expect(photo.headers.get('x-content-type-options')).toBe('nosniff');

		const other = await get('evil.txt');
		expect(other.headers.get('content-type')).toBe('application/octet-stream');
		expect(other.headers.get('content-disposition')).toMatch(/^attachment/);
		expect((await app.request(`${BASE}/api/v1/probe/files/photo.png`)).status).toBe(401);
		expect((await get('missing.png')).status).toBe(404);
	});
});
