import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { createBackup, restoreBackup } from '@famos/db';
import type { ExternalHttp } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { createThemeRegistry, findBundledThemes } from '../src/themes.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const BASE = 'http://localhost:3000';

const woff2 = () => {
	const bytes = new Uint8Array(64);
	bytes.set([0x77, 0x4f, 0x46, 0x32]);
	return Buffer.from(bytes).toString('base64');
};

/** A small valid pack: it leaves most tokens to Ev Işığı. */
function tinyPack(id = 'sand', options: { font?: boolean; wall?: string; ink?: string } = {}) {
	const manifest: Record<string, unknown> = {
		id,
		name: 'Sand',
		version: '1.0.0',
		famos: '>=0.1.0',
		...(options.font && { fonts: { 'Sand Sans': [{ file: 'sand.woff2', weight: '100 900' }] } }),
	};
	return {
		manifest,
		tokens: {
			day: {
				wall: options.wall ?? '#f4ecd8',
				surface: '#fffaf0',
				idle: '#e8dcc0',
				'ink-soft': '#4a4030',
				ink: options.ink ?? '#1a1408',
			},
			night: {
				wall: '#16130c',
				surface: '#221e14',
				idle: '#1c1810',
				'ink-soft': '#c9c0a8',
				ink: '#f6efdc',
			},
			...(options.font && { font: 'Sand Sans' }),
		},
		...(options.font && { fonts: { 'sand.woff2': woff2() } }),
	};
}

let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;
let fakeHttp: { body: string };

async function boot() {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-theme-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	fakeHttp = { body: JSON.stringify(tinyPack('remote')) };
	const http: ExternalHttp = {
		async get() {
			return { status: 200, text: fakeHttp.body, etag: null, lastModified: null };
		},
	};
	runtime = openRuntime(config, {
		extensions,
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
		http,
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
}
beforeEach(boot);
afterEach(() => runtime.close());

let ip = 0;
async function call(method: string, path: string, body?: unknown, cookie?: string, headers = {}) {
	const res = await app.request(`${BASE}${path}`, {
		method,
		headers: {
			origin: BASE,
			'x-forwarded-for': `10.3.0.${++ip}`,
			...(body !== undefined && { 'content-type': 'application/json' }),
			...(cookie && { cookie }),
			...headers,
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	return {
		status: res.status,
		headers: res.headers,
		text,
		body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; '),
	};
}

async function setupAdmin() {
	const setup = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: 'correct horse battery',
		locale: 'en',
		setupCode: runtime.config.setupCode,
	});
	expect(setup.status).toBe(201);
	const signIn = await call('POST', '/api/auth/sign-in/email', {
		email: 'parent@example.com',
		password: 'correct horse battery',
	});
	return { admin: setup.body, cookie: signIn.cookie };
}

async function addKid(adminCookie: string) {
	const created = await call(
		'POST',
		'/api/v1/actions/core.createMember',
		{ displayName: 'Kid', roleId: 'member' },
		adminCookie,
	);
	const kid = created.body.output;
	await call(
		'PUT',
		`/api/v1/core/members/${kid.id}/password`,
		{ email: 'kid@example.com', password: 'another long password' },
		adminCookie,
	);
	const signIn = await call('POST', '/api/auth/sign-in/email', {
		email: 'kid@example.com',
		password: 'another long password',
	});
	return { kid, cookie: signIn.cookie };
}

const act = (id: string, body: unknown, cookie: string) =>
	call('POST', `/api/v1/actions/${id}`, body, cookie);

describe('the bundled packs', () => {
	it('ships six themes, Ev Işığı first and all of them loaded', () => {
		const dir = findBundledThemes(undefined);
		expect(dir).toBeTruthy();
		const registry = createThemeRegistry({
			appVersion: APP_VERSION,
			bundledDir: dir,
			installedDir: '/nonexistent',
			logger: silentLogger,
		});
		expect(registry.list().map((t) => t.id)).toEqual([
			'ev-isigi',
			'coast',
			'forest',
			'high-contrast',
			'paper',
			'plum',
		]);
		expect(registry.list().every((t) => t.source === 'bundled')).toBe(true);
	});
});

describe('the registry', () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'famos-theme-registry-'));
	});
	afterEach(() => rm(root, { recursive: true, force: true }));

	const registry = () =>
		createThemeRegistry({
			appVersion: APP_VERSION,
			bundledDir: findBundledThemes(undefined),
			installedDir: join(root, 'installed'),
			logger: silentLogger,
		});

	it('installs to disk with its fonts, survives a restart and serves its font', async () => {
		const themes = registry();
		const { theme } = await themes.install(tinyPack('sand', { font: true }));
		expect(theme).toMatchObject({ id: 'sand', source: 'installed', overridesBundled: false });
		expect((await readdir(join(root, 'installed', 'sand'))).sort()).toEqual([
			'manifest.json',
			'sand.woff2',
			'tokens.json',
		]);
		const again = registry();
		expect(again.has('sand')).toBe(true);
		const sheet = again.stylesheet('sand');
		expect(sheet?.css).toContain('font-family: "Sand Sans"');
		expect(sheet?.css).toContain('/api/v1/core/themes/sand/fonts/sand.woff2');
		const font = again.font('sand', 'sand.woff2');
		expect(font?.size).toBe(64);
		expect(again.font('sand', '../manifest.json')).toBeNull();
		expect(again.font('sand', 'other.woff2')).toBeNull();
	});

	it('lets an installed pack override a bundled one and reverts when removed', async () => {
		const themes = registry();
		const bundledVersion = themes.list().find((t) => t.id === 'coast')?.version;
		await themes.install({
			...tinyPack('coast'),
			manifest: { ...tinyPack('coast').manifest, name: 'Mine' },
		});
		expect(themes.list().find((t) => t.id === 'coast')).toMatchObject({
			name: 'Mine',
			source: 'installed',
			overridesBundled: true,
		});
		await themes.remove('coast');
		expect(themes.list().find((t) => t.id === 'coast')).toMatchObject({
			source: 'bundled',
			version: bundledVersion,
		});
		await expect(themes.remove('coast')).rejects.toMatchObject({ code: 'not_found' });
	});

	it('refuses a pack that fails contrast and says why', async () => {
		const bad = tinyPack('murky', { ink: '#d8cfb4' });
		await expect(registry().install(bad)).rejects.toMatchObject({
			code: 'bad_request',
			message: expect.stringContaining('Contrast: ink on wall (day)'),
		});
	});

	it('skips a broken installed pack at start without failing', async () => {
		await mkdir(join(root, 'installed', 'broken'), { recursive: true });
		await writeFile(join(root, 'installed', 'broken', 'manifest.json'), '{ not json');
		expect(registry().list().length).toBe(6);
	});
});

describe('the theme routes', () => {
	it('lists themes and serves a stylesheet without signing in', async () => {
		const list = await call('GET', '/api/v1/core/themes');
		expect(list.status).toBe(200);
		expect(list.body[0]).toMatchObject({ id: 'ev-isigi', source: 'bundled' });
		expect(list.body[0].preview.day.wall).toBe('#ecebe6');

		const css = await call('GET', '/api/v1/core/themes/high-contrast/stylesheet.css');
		expect(css.status).toBe(200);
		expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
		expect(css.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
		expect(css.text).toContain('html:root,\nhtml .day {');
		expect(css.text).toContain('--wall: #f2f2f2;');
		expect(css.text).toContain('html.dark {');
		const etag = css.headers.get('etag') as string;
		const cached = await call(
			'GET',
			'/api/v1/core/themes/high-contrast/stylesheet.css',
			undefined,
			undefined,
			{
				'if-none-match': etag,
			},
		);
		expect(cached.status).toBe(304);
		expect((await call('GET', '/api/v1/core/themes/nope/stylesheet.css')).status).toBe(404);
		expect(
			(await call('GET', '/api/v1/core/themes/..%2Fx/stylesheet.css')).status,
		).toBeGreaterThanOrEqual(400);
	});

	it('serves an installed pack font from our own origin with its content type', async () => {
		const { cookie } = await setupAdmin();
		await act('core.installThemePack', { pack: tinyPack('sand', { font: true }) }, cookie);
		const font = await call('GET', '/api/v1/core/themes/sand/fonts/sand.woff2');
		expect(font.status).toBe(200);
		expect(font.headers.get('content-type')).toBe('font/woff2');
		expect((await call('GET', '/api/v1/core/themes/sand/fonts/missing.woff2')).status).toBe(404);
		expect((await call('GET', '/api/v1/core/themes/sand/fonts/sand.ttf')).status).toBe(400);
	});

	it('lets only admins install, remove and set the family or display theme', async () => {
		const { cookie } = await setupAdmin();
		const { cookie: kidCookie } = await addKid(cookie);
		for (const [id, body] of [
			['core.installThemePack', { pack: tinyPack() }],
			['core.removeThemePack', { id: 'coast' }],
			['core.setFamilyTheme', { theme: 'coast' }],
			['core.installThemePackFromUrl', { url: 'https://packs.example.com/x.json' }],
			['core.setDisplayTheme', { deviceId: 'x', theme: 'coast' }],
		] as const) {
			expect((await act(id, body, kidCookie)).status, id).toBe(403);
		}
	});

	it('resolves the theme: own choice, else the family default, with fallbacks', async () => {
		const { cookie } = await setupAdmin();
		const { cookie: kidCookie } = await addKid(cookie);
		const appearance = async (c?: string) =>
			(await call('GET', '/api/v1/core/appearance', undefined, c)).body;

		expect(await appearance()).toMatchObject({ theme: 'ev-isigi', family: 'ev-isigi', mine: null });

		expect((await act('core.setFamilyTheme', { theme: 'high-contrast' }, cookie)).status).toBe(200);
		expect(await appearance()).toMatchObject({ theme: 'high-contrast', family: 'high-contrast' });
		expect(await appearance(kidCookie)).toMatchObject({ theme: 'high-contrast', mine: null });

		// A member chooses their own; it changes nothing for anyone else.
		const mine = await act('core.setMyTheme', { theme: 'forest' }, kidCookie);
		expect(mine.status).toBe(200);
		expect(await appearance(kidCookie)).toMatchObject({
			theme: 'forest',
			mine: 'forest',
			family: 'high-contrast',
		});
		expect(await appearance(cookie)).toMatchObject({ theme: 'high-contrast', mine: null });
		expect((await act('core.setMyTheme', { theme: 'nope' }, kidCookie)).status).toBe(400);
		await act('core.setMyTheme', { theme: null }, kidCookie);
		expect(await appearance(kidCookie)).toMatchObject({ theme: 'high-contrast', mine: null });
		expect((await act('core.setFamilyTheme', { theme: 'nope' }, cookie)).status).toBe(400);
	});

	it("resolves the style through /appearance: own, family, the pack's preference, default", async () => {
		const { cookie } = await setupAdmin();
		const { cookie: kidCookie } = await addKid(cookie);
		const appearance = async (c?: string) =>
			(await call('GET', '/api/v1/core/appearance', undefined, c)).body;
		expect(await appearance(kidCookie)).toMatchObject({
			style: 'broadsheet',
			familyStyle: null,
			myStyle: null,
		});

		// An installed pack that suggests Wall: it counts while the family has no style.
		const pack = tinyPack('sand');
		pack.manifest.style = 'wall';
		const installed = await act('core.installThemePack', { pack }, cookie);
		expect(installed.body.output.theme.style).toBe('wall');
		await act('core.setFamilyTheme', { theme: 'sand' }, cookie);
		expect(await appearance()).toMatchObject({ theme: 'sand', style: 'wall' });

		expect((await act('core.setFamilyStyle', { style: 'lanes' }, cookie)).status).toBe(200);
		expect(await appearance(kidCookie)).toMatchObject({ style: 'lanes', familyStyle: 'lanes' });
		expect((await act('core.setMyStyle', { style: 'wall' }, kidCookie)).status).toBe(200);
		expect(await appearance(kidCookie)).toMatchObject({ style: 'wall', myStyle: 'wall' });
		expect(await appearance(cookie)).toMatchObject({ style: 'lanes', myStyle: null });

		expect((await act('core.setMyStyle', { style: 'mosaic' }, kidCookie)).status).toBe(400);
		expect((await act('core.setFamilyStyle', { style: 'wall' }, kidCookie)).status).toBe(403);
		expect(
			(await act('core.setDisplayStyle', { deviceId: 'x', style: 'wall' }, kidCookie)).status,
		).toBe(403);
	});

	it('reports and ignores a style the app does not know', async () => {
		const { cookie } = await setupAdmin();
		const pack = tinyPack('sand');
		pack.manifest.style = 'mosaic';
		const res = await act('core.installThemePack', { pack }, cookie);
		expect(res.status).toBe(200);
		expect(res.body.output.warnings).toContain('Unknown style "mosaic" is ignored');
		expect(res.body.output.theme.style).toBeNull();
	});

	it('falls back when a chosen installed theme is removed', async () => {
		const { cookie } = await setupAdmin();
		await act('core.installThemePack', { pack: tinyPack('sand') }, cookie);
		await act('core.setFamilyTheme', { theme: 'sand' }, cookie);
		await act('core.setMyTheme', { theme: 'sand' }, cookie);
		expect((await call('GET', '/api/v1/core/appearance', undefined, cookie)).body).toMatchObject({
			theme: 'sand',
			mine: 'sand',
		});
		const removed = await act('core.removeThemePack', { id: 'sand' }, cookie);
		expect(removed.status).toBe(200);
		expect((await call('GET', '/api/v1/core/appearance', undefined, cookie)).body).toMatchObject({
			theme: 'ev-isigi',
			family: 'ev-isigi',
			mine: null,
		});
		// A bundled pack cannot be removed.
		expect((await act('core.removeThemePack', { id: 'coast' }, cookie)).status).toBe(404);
	});

	it('refuses a pack with the reasons, and lists them', async () => {
		const { cookie } = await setupAdmin();
		const res = await act(
			'core.installThemePack',
			{ pack: tinyPack('murky', { ink: '#d8cfb4' }) },
			cookie,
		);
		expect(res.status).toBe(400);
		expect(res.text).toContain('Contrast: ink on wall (day)');
		const unknownToken = tinyPack('sand');
		(unknownToken.tokens.day as Record<string, string>).sparkle = '#fff';
		const ok = await act('core.installThemePack', { pack: unknownToken }, cookie);
		expect(ok.body.output.warnings).toContain('Unknown token "sparkle" in day is ignored');
	});

	it('gives a display its own theme, else the family default', async () => {
		const { cookie } = await setupAdmin();
		runtime.handle.sqlite
			.prepare(
				"INSERT INTO core_devices (id, name, kind, token_hash, created_by, created_at, last_seen_at) VALUES ('dev_1', 'Kitchen', 'kiosk', 'h', 'x', 1, 1)",
			)
			.run();
		await act('core.setFamilyTheme', { theme: 'paper' }, cookie);
		const display = {
			kind: 'display',
			deviceId: 'dev_1',
			capabilities: [],
			showNames: false,
		} as const;
		const effective = () => runtime.kernel.themes.effective(runtime.kernel.ctx.db, display);
		expect((await effective()).theme).toBe('paper');
		expect(
			(await act('core.setDisplayTheme', { deviceId: 'dev_1', theme: 'plum' }, cookie)).status,
		).toBe(200);
		expect((await effective()).theme).toBe('plum');
		expect((await call('GET', '/api/v1/core/themes/displays', undefined, cookie)).body).toEqual({
			dev_1: 'plum',
		});
		expect(
			(await act('core.setDisplayTheme', { deviceId: 'nope', theme: 'plum' }, cookie)).status,
		).toBe(404);
		await act('core.setDisplayTheme', { deviceId: 'dev_1', theme: null }, cookie);
		expect((await effective()).theme).toBe('paper');
	});
});

describe('installing from an address', () => {
	it('fetches through the guarded HTTP port in a job, then installs', async () => {
		const { cookie } = await setupAdmin();
		const queued = await act(
			'core.installThemePackFromUrl',
			{ url: 'https://packs.example.com/remote.json' },
			cookie,
		);
		expect(queued.body.output).toEqual({ queued: true });
		await runtime.kernel.worker.drain();
		expect((await call('GET', '/api/v1/core/themes/fetch', undefined, cookie)).body).toMatchObject({
			status: 'done',
			error: null,
		});
		expect(
			(await call('GET', '/api/v1/core/themes')).body.find(
				(t: { id: string }) => t.id === 'remote',
			),
		).toMatchObject({
			source: 'installed',
			url: 'https://packs.example.com/remote.json',
		});
	});

	it('reports a refused or unreadable answer in plain words', async () => {
		const { cookie } = await setupAdmin();
		fakeHttp.body = 'not json';
		await act('core.installThemePackFromUrl', { url: 'https://packs.example.com/a.json' }, cookie);
		await runtime.kernel.worker.drain();
		expect((await call('GET', '/api/v1/core/themes/fetch', undefined, cookie)).body).toMatchObject({
			status: 'failed',
			error: 'The address did not return a theme pack',
		});
		fakeHttp.body = JSON.stringify(tinyPack('murky', { ink: '#d8cfb4' }));
		await act('core.installThemePackFromUrl', { url: 'https://packs.example.com/b.json' }, cookie);
		await runtime.kernel.worker.drain();
		expect((await call('GET', '/api/v1/core/themes/fetch', undefined, cookie)).body).toMatchObject({
			status: 'failed',
			error: expect.stringContaining('The pack was refused: Contrast: ink on wall (day)'),
		});
	});
});

describe('backups', () => {
	it('carry installed theme packs and restore them', async () => {
		const { cookie } = await setupAdmin();
		await act('core.installThemePack', { pack: tinyPack('sand', { font: true }) }, cookie);
		const { path } = await createBackup({
			sqlite: runtime.handle.sqlite,
			filesDir: runtime.config.filesDir,
			themesDir: runtime.config.themesDir,
			backupsDir: runtime.config.backupsDir,
			appVersion: APP_VERSION,
			schema: {},
			reason: 'manual',
		});
		await rm(runtime.config.themesDir, { recursive: true, force: true });
		const restored = await mkdtemp(join(tmpdir(), 'famos-theme-restore-'));
		await restoreBackup({
			file: path,
			dbPath: join(restored, 'famos.db'),
			filesDir: join(restored, 'files'),
			themesDir: join(restored, 'themes'),
		});
		expect(
			JSON.parse(await readFile(join(restored, 'themes', 'sand', 'manifest.json'), 'utf8')).id,
		).toBe('sand');
		expect((await readdir(join(restored, 'themes', 'sand'))).sort()).toEqual([
			'manifest.json',
			'sand.woff2',
			'tokens.json',
		]);
	});
});
