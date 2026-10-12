import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';

/**
 * Records and "Add to…" through the real HTTP stack (the E2E waits for the first domain extension): sharing papers to the Inbox with a record named files them without the AI.
 */
const BASE = 'http://localhost:3000';
const CAR = 'vehicle_00000000-0000-7000-8000-000000000001';

let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;
let cookie: string;
let ip = 0;

beforeEach(async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-records-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	runtime = openRuntime(config, {
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
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
		trustedProxies: ['127.0.0.1'],
	});
	const json = (path: string, body: unknown) =>
		app.request(`${BASE}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: BASE,
				'x-forwarded-for': `10.3.0.${++ip}`,
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

const get = (path: string, withCookie = true) =>
	app.request(`${BASE}${path}`, { headers: { ...(withCookie && { cookie }) } });
const post = (path: string, body: unknown) =>
	app.request(`${BASE}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: BASE, cookie },
		body: JSON.stringify(body),
	});

describe('records over HTTP', () => {
	it('files a shared paper on a record without the AI, and serves it from the record only', async () => {
		const form = new FormData();
		form.append('channel', 'share');
		form.append('fileToRecordId', CAR);
		form.append('fileToRecordKind', 'vehicle');
		form.append('fileToRecordName', 'Golf');
		form.append('fileToLabel', 'policy');
		form.append('files', new File(['%PDF-1.4 policy'], 'policy.pdf', { type: 'application/pdf' }));
		const shared = await app.request(`${BASE}/api/v1/inbox/items`, {
			method: 'POST',
			headers: { origin: BASE, cookie },
			body: form,
		});
		expect(shared.status).toBe(201);
		const item = (await shared.json()) as { id: string; status: string; filedTo: unknown };
		expect(item.status).toBe('filed');
		expect(item.filedTo).toMatchObject({ recordId: CAR, label: 'policy', recordName: 'Golf' });

		await runtime.kernel.worker.drain();
		const items = (await (await get('/api/v1/inbox/items')).json()) as { status: string }[];
		expect(items.map((i) => i.status)).toEqual(['filed']);

		const docs = (await (await get(`/api/v1/records/documents?recordId=${CAR}`)).json()) as {
			id: string;
			name: string;
			label: string;
		}[];
		expect(docs).toMatchObject([{ name: 'policy.pdf', label: 'policy' }]);
		const paper = await get(`/api/v1/records/documents/${docs[0]?.id}/file`);
		expect(paper.status).toBe(200);
		expect(paper.headers.get('content-type')).toBe('application/pdf');
		expect(paper.headers.get('content-security-policy')).toMatch(/sandbox/);
		expect(await paper.text()).toBe('%PDF-1.4 policy');
		expect((await get(`/api/v1/records/documents/${docs[0]?.id}/file`, false)).status).toBe(401);
	});

	it('adds, lists and completes an obligation through the API', async () => {
		const added = await post('/api/v1/actions/records.addObligation', {
			recordId: CAR,
			recordKind: 'vehicle',
			recordName: 'Golf',
			recordUrl: `/vehicles/${CAR}`,
			title: 'Inspection',
			dueDate: '2099-01-31',
			every: { months: 1 },
		});
		expect(added.status).toBe(200);
		const { output } = (await added.json()) as { output: { id: string } };
		const upcoming = await get('/api/v1/records/upcoming?days=366');
		expect(upcoming.status).toBe(200);
		expect(await upcoming.json()).toEqual([]);
		const list = (await (await get(`/api/v1/records/obligations?recordId=${CAR}`)).json()) as {
			id: string;
			dueDate: string;
		}[];
		expect(list.map((o) => o.id)).toEqual([output.id]);
		const done = await post('/api/v1/actions/records.completeObligation', { id: output.id });
		expect(done.status).toBe(200);
		const history = (await (
			await get(`/api/v1/records/obligations/${output.id}/history`)
		).json()) as unknown[];
		expect(history).toHaveLength(1);
		const after = (await (await get(`/api/v1/records/obligations?recordId=${CAR}`)).json()) as {
			dueDate: string;
		}[];
		expect(after).toMatchObject([{ dueDate: '2099-02-28' }]);
	});
});
