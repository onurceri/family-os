import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import { createBackup, restoreBackup } from '@famos/db';
import { type ExternalHttp, ExternalHttpError } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http/app.ts';
import { catalogsOf, createTranslate } from '../src/i18n.ts';
import { createLanguageRegistry } from '../src/languages.ts';
import { APP_VERSION, migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { discoverSourceExtensions } from './support/extensions.ts';

const extensions = await discoverSourceExtensions();

const BASE = 'http://localhost:3000';

/** A tiny but valid pack: a handful of keys; the rest of the app falls back to English. */
function tinyPack(code = 'xx', overrides: Record<string, string> = {}) {
	return {
		manifest: {
			code,
			name: 'Testish',
			nativeName: 'Testisch',
			version: '1.0.0',
			famos: '>=0.1.0',
		},
		catalogs: {
			app: { nav_more: 'Mehr-test', push_test_title: 'Testtitel', ...overrides },
		},
	};
}

let runtime: Runtime;
let app: ReturnType<typeof createHttpApp>;
let fakeHttp: { body: string | Error };

async function boot() {
	const dataDir = await mkdtemp(join(tmpdir(), 'famos-lang-'));
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
	fakeHttp = { body: JSON.stringify(tinyPack('yy')) };
	const http: ExternalHttp = {
		async get() {
			if (fakeHttp.body instanceof Error) throw fakeHttp.body;
			return { status: 200, text: fakeHttp.body, etag: null, lastModified: null };
		},
		post: () => Promise.reject(new Error('Nothing is posted here')),
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
			'x-forwarded-for': `10.2.0.${++ip}`,
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

async function setupAdmin(locale = 'en') {
	const setup = await call('POST', '/api/v1/core/setup', {
		displayName: 'Parent',
		email: 'parent@example.com',
		password: 'correct horse battery',
		locale,
		setupCode: runtime.config.setupCode,
	});
	expect(setup.status).toBe(201);
	const signIn = await call('POST', '/api/auth/sign-in/email', {
		email: 'parent@example.com',
		password: 'correct horse battery',
	});
	return { admin: setup.body, cookie: signIn.cookie };
}

async function addMember(adminCookie: string, roleId = 'member') {
	const created = await call(
		'POST',
		'/api/v1/actions/core.createMember',
		{ displayName: 'Kid', roleId },
		adminCookie,
	);
	expect(created.body.status).toBe('applied');
	return created.body.output;
}

describe('the registry', () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'famos-registry-'));
	});
	afterEach(() => rm(root, { recursive: true, force: true }));

	const write = async (
		dir: string,
		pack: { manifest: { code: string }; catalogs: Record<string, unknown> },
	) => {
		await mkdir(join(dir, pack.manifest.code), { recursive: true });
		await writeFile(join(dir, pack.manifest.code, 'manifest.json'), JSON.stringify(pack.manifest));
		for (const [ns, catalog] of Object.entries(pack.catalogs))
			await writeFile(join(dir, pack.manifest.code, `${ns}.json`), JSON.stringify(catalog));
	};
	const registry = () =>
		createLanguageRegistry({
			...catalogsOf(extensions),
			appVersion: APP_VERSION,
			bundledDir: join(root, 'bundled'),
			installedDir: join(root, 'installed'),
			logger: silentLogger,
		});

	it('lists English first, then bundled packs with coverage', async () => {
		await write(join(root, 'bundled'), tinyPack('aa'));
		const list = registry().list();
		expect(list.map((l) => [l.code, l.source])).toEqual([
			['en', 'base'],
			['aa', 'bundled'],
		]);
		expect(list[1]?.coverage).toBeGreaterThan(0);
		expect(list[1]?.coverage).toBeLessThan(0.01);
	});

	it('lets an installed pack override a bundled one of the same code, and reverts when removed', async () => {
		await write(join(root, 'bundled'), tinyPack('aa', { nav_more: 'Bundled' }));
		await write(join(root, 'installed'), tinyPack('aa', { nav_more: 'Installed' }));
		const languages = registry();
		const entry = languages.list().find((l) => l.code === 'aa');
		expect(entry).toMatchObject({ source: 'installed', overridesBundled: true });
		const catalogs = languages.catalogs('aa')?.catalogs as { app: { nav_more: string } };
		expect(catalogs.app.nav_more).toBe('Installed');
		await languages.remove('aa');
		expect(languages.list().find((l) => l.code === 'aa')).toMatchObject({
			source: 'bundled',
			overridesBundled: false,
		});
		// A bundled pack cannot be removed.
		await expect(languages.remove('aa')).rejects.toMatchObject({ code: 'not_found' });
	});

	it('skips a broken pack and a folder named differently from its code', async () => {
		await write(join(root, 'bundled'), tinyPack('aa'));
		await mkdir(join(root, 'bundled', 'broken'));
		await writeFile(join(root, 'bundled', 'broken', 'manifest.json'), '{ not json');
		await mkdir(join(root, 'bundled', 'bb'));
		await writeFile(
			join(root, 'bundled', 'bb', 'manifest.json'),
			JSON.stringify(tinyPack('cc').manifest),
		);
		expect(
			registry()
				.list()
				.map((l) => l.code),
		).toEqual(['en', 'aa']);
	});

	it('installs to disk, survives a restart and bumps its version', async () => {
		const languages = registry();
		const before = languages.version;
		const { language } = await languages.install(tinyPack('aa'));
		expect(language).toMatchObject({ code: 'aa', source: 'installed' });
		expect(languages.version).toBeGreaterThan(before);
		expect(await readdir(join(root, 'installed'))).toEqual(['aa']);
		expect(registry().has('aa')).toBe(true);
		await expect(languages.install({ manifest: {}, catalogs: {} })).rejects.toMatchObject({
			code: 'bad_request',
		});
	});

	it("takes a pack that lacks an extension's strings, which only lowers its coverage", async () => {
		const languages = registry();
		const { language, problems } = await languages.install(tinyPack('aa'));
		expect(problems).toEqual([]);
		expect(language.coverage).toBeGreaterThan(0);
		expect(language.coverage).toBeLessThan(0.01);
		expect(languages.catalogs('aa')?.catalogs.home).toBeUndefined();
		// Strings of an extension that is not installed are left out, not refused.
		const extra = tinyPack('ab');
		const withUnknown = { ...extra, catalogs: { ...extra.catalogs, garden: { beds: 'Beete' } } };
		expect((await languages.install(withUnknown)).problems).toEqual([]);
		expect(languages.catalogs('ab')?.catalogs.garden).toBeUndefined();
	});

	it("shows a pack over an extension's own translation, and the extension's where the pack has none", async () => {
		await write(join(root, 'installed'), {
			...tinyPack('tr'),
			catalogs: { app: { nav_more: 'Paket' }, home: { nav: 'Paketten ev' } },
		});
		const languages = registry();
		const catalogs = languages.catalogs('tr')?.catalogs as Record<string, Record<string, string>>;
		expect(catalogs.app?.nav_more).toBe('Paket');
		expect(catalogs.home?.nav).toBe('Paketten ev');
		// The pack has nothing else of home or calendar: their own Turkish fills in.
		expect(catalogs.home?.feature_name).toBe('Ev');
		expect(catalogs.calendar?.nav).toBeTruthy();
		const translate = createTranslate(languages);
		expect(translate('tr', 'home:feature_name')).toBe('Ev');
		expect(translate('tr', 'home:nav')).toBe('Paketten ev');
		// The app's strings the pack lacks are English: the installed pack replaces the bundled one.
		expect(translate('tr', 'nav_home')).toBe('Today');
	});

	it('renders in the language with English fallback, and follows installs', async () => {
		const languages = registry();
		const translate = createTranslate(languages);
		expect(translate('aa', 'nav_more')).toBe('More');
		await languages.install(tinyPack('aa'));
		expect(translate('aa', 'nav_more')).toBe('Mehr-test');
		// Not in the pack: English. Unknown language: English.
		expect(translate('aa', 'nav_home')).toBe('Today');
		expect(translate('zz', 'nav_more')).toBe('More');
		await languages.remove('aa');
		expect(translate('aa', 'nav_more')).toBe('More');
	});
});

describe('the bundled Turkish pack', () => {
	it('is listed, complete, and renders server texts', async () => {
		const { cookie } = await setupAdmin();
		const list = await call('GET', '/api/v1/core/languages');
		expect(list.status).toBe(200);
		expect(list.body[0]).toMatchObject({ code: 'en', source: 'base' });
		expect(list.body.find((l: { code: string }) => l.code === 'tr')).toMatchObject({
			nativeName: 'Türkçe',
			name: 'Turkish',
			dir: 'ltr',
			source: 'bundled',
			coverage: 1,
		});
		expect(cookie).toBeTruthy();
		expect(runtime.kernel.translate('tr', 'nav_more')).toBe('Daha');
		expect(runtime.kernel.translate('en', 'nav_more')).toBe('More');
		// The extensions' strings come from their own Turkish.
		expect(runtime.kernel.translate('tr', 'home:feature_name')).toBe('Ev');
		expect(runtime.kernel.translate('en', 'home:feature_name')).toBe('Home');
	});
});

describe('the language routes', () => {
	it('lists languages without signing in (setup and sign-in need them)', async () => {
		const list = await call('GET', '/api/v1/core/languages');
		expect(list.status).toBe(200);
		expect(list.body.map((l: { code: string }) => l.code)).toEqual(['en', 'tr']);
	});

	it('serves a pack with an ETag, answers 304 to it, and does not serve English', async () => {
		const first = await call('GET', '/api/v1/core/languages/tr/catalogs');
		expect(first.status).toBe(200);
		expect(first.headers.get('content-type')).toContain('application/json');
		expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
		const etag = first.headers.get('etag');
		expect(etag).toMatch(/^"/);
		expect(first.body).toMatchObject({
			code: 'tr',
			dir: 'ltr',
			version: etag?.replaceAll('"', ''),
		});
		expect(Object.keys(first.body.catalogs).sort()).toEqual(
			['app', ...extensions.map((e) => e.id)].sort(),
		);
		expect(first.body.catalogs.app.nav_more).toBe('Daha');
		expect(first.body.catalogs.home.feature_name).toBe('Ev');

		const again = await call('GET', '/api/v1/core/languages/tr/catalogs', undefined, undefined, {
			'if-none-match': etag as string,
		});
		expect(again.status).toBe(304);
		expect(again.text).toBe('');

		expect((await call('GET', '/api/v1/core/languages/en/catalogs')).status).toBe(404);
		expect((await call('GET', '/api/v1/core/languages/zz/catalogs')).status).toBe(404);
	});

	it('lets only admins install and remove packs', async () => {
		const { cookie } = await setupAdmin();
		const kid = await addMember(cookie);
		const created = await call(
			'PUT',
			`/api/v1/core/members/${kid.id}/password`,
			{ email: 'kid@example.com', password: 'another long password' },
			cookie,
		);
		expect(created.status).toBeLessThan(300);
		const signIn = await call('POST', '/api/auth/sign-in/email', {
			email: 'kid@example.com',
			password: 'another long password',
		});
		const install = await call(
			'POST',
			'/api/v1/actions/core.installLanguagePack',
			{ pack: tinyPack() },
			signIn.cookie,
		);
		expect(install.status).toBe(403);
		const remove = await call(
			'POST',
			'/api/v1/actions/core.removeLanguagePack',
			{ code: 'tr' },
			signIn.cookie,
		);
		expect(remove.status).toBe(403);
	});

	it('installs a pack, validates codes against it, and falls back when it is removed', async () => {
		const { admin, cookie } = await setupAdmin();
		const kid = await addMember(cookie);

		// Not available yet: refused for the family and for a person.
		const early = await call(
			'POST',
			'/api/v1/actions/core.updateFamilySettings',
			{ locale: 'xx' },
			cookie,
		);
		expect(early.status).toBe(400);
		expect(
			(
				await call(
					'POST',
					'/api/v1/actions/core.updateMember',
					{ memberId: kid.id, locale: 'xx' },
					cookie,
				)
			).status,
		).toBe(400);
		expect(
			(
				await call(
					'POST',
					'/api/v1/actions/core.updateFamilySettings',
					{ locale: 'not a locale' },
					cookie,
				)
			).status,
		).toBe(400);

		const install = await call(
			'POST',
			'/api/v1/actions/core.installLanguagePack',
			{ pack: tinyPack() },
			cookie,
		);
		expect(install.status).toBe(200);
		expect(install.body.output.language).toMatchObject({
			code: 'xx',
			source: 'installed',
			installedAt: expect.any(Number),
		});
		expect(install.body.output.problems).toEqual([]);
		const listed = await call('GET', '/api/v1/core/languages');
		expect(listed.body.map((l: { code: string }) => l.code)).toContain('xx');

		// Now family and members may use it.
		expect(
			(await call('POST', '/api/v1/actions/core.updateFamilySettings', { locale: 'xx' }, cookie))
				.body.output.locale,
		).toBe('xx');
		await call(
			'POST',
			'/api/v1/actions/core.updateMember',
			{ memberId: kid.id, locale: 'xx' },
			cookie,
		);
		// A member sets their own language without a manager capability.
		const mine = await call('POST', '/api/v1/actions/core.setMyLanguage', { locale: 'tr' }, cookie);
		expect(mine.body.output.locale).toBe('tr');
		expect(
			(await call('POST', '/api/v1/actions/core.setMyLanguage', { locale: null }, cookie)).body
				.output.locale,
		).toBeNull();
		expect(
			(await call('POST', '/api/v1/actions/core.setMyLanguage', { locale: 'zz' }, cookie)).status,
		).toBe(400);
		void admin;

		// Remove: the family and the kid are back on English / the family default.
		const removed = await call(
			'POST',
			'/api/v1/actions/core.removeLanguagePack',
			{ code: 'xx' },
			cookie,
		);
		expect(removed.status).toBe(200);
		expect((await call('GET', '/api/v1/core/settings/family', undefined, cookie)).body.locale).toBe(
			'en',
		);
		const members = await call('GET', '/api/v1/core/members', undefined, cookie);
		expect(members.body.find((m: { id: string }) => m.id === kid.id).locale).toBeNull();
		expect(
			(await call('GET', '/api/v1/core/languages')).body.map((l: { code: string }) => l.code),
		).not.toContain('xx');

		// A bundled pack cannot be removed.
		const bundled = await call(
			'POST',
			'/api/v1/actions/core.removeLanguagePack',
			{ code: 'tr' },
			cookie,
		);
		expect(bundled.status).toBe(404);
	});

	it('reports unusable strings of an installed pack and drops them', async () => {
		const { cookie } = await setupAdmin();
		const pack = tinyPack('xx', { nav_home: '{{wrong}}', nonexistent_key: 'x' });
		const install = await call(
			'POST',
			'/api/v1/actions/core.installLanguagePack',
			{ pack },
			cookie,
		);
		expect(install.status).toBe(200);
		expect(install.body.output.problems).toEqual(
			expect.arrayContaining([{ namespace: 'app', key: 'nonexistent_key', kind: 'unknown_key' }]),
		);
		const catalogs = (await call('GET', '/api/v1/core/languages/xx/catalogs')).body.catalogs;
		expect(catalogs.app.nav_more).toBe('Mehr-test');
		expect(catalogs.app.nonexistent_key).toBeUndefined();
	});

	it('refuses a pack that is not valid', async () => {
		const { cookie } = await setupAdmin();
		const bad = tinyPack();
		bad.manifest.code = 'en';
		const res = await call(
			'POST',
			'/api/v1/actions/core.installLanguagePack',
			{ pack: bad },
			cookie,
		);
		expect(res.status).toBe(400);
		const newer = tinyPack();
		newer.manifest.famos = '>=99.0.0';
		expect(
			(await call('POST', '/api/v1/actions/core.installLanguagePack', { pack: newer }, cookie))
				.status,
		).toBe(400);
	});
});

describe('installing from an address', () => {
	it('fetches through the guarded HTTP port in a job, then installs', async () => {
		const { cookie } = await setupAdmin();
		const queued = await call(
			'POST',
			'/api/v1/actions/core.installLanguagePackFromUrl',
			{ url: 'https://packs.example.com/yy.json' },
			cookie,
		);
		expect(queued.body.output).toEqual({ queued: true });
		expect(
			(await call('GET', '/api/v1/core/languages/fetch', undefined, cookie)).body,
		).toMatchObject({
			status: 'fetching',
		});
		await runtime.kernel.worker.drain();
		expect(
			(await call('GET', '/api/v1/core/languages/fetch', undefined, cookie)).body,
		).toMatchObject({
			status: 'done',
			error: null,
		});
		const listed = (await call('GET', '/api/v1/core/languages')).body;
		expect(listed.find((l: { code: string }) => l.code === 'yy')).toMatchObject({
			source: 'installed',
			url: 'https://packs.example.com/yy.json',
		});
	});

	it('records a refused pack with its reason instead of failing the job', async () => {
		const { cookie } = await setupAdmin();
		const refused = tinyPack();
		refused.manifest.code = 'en';
		fakeHttp.body = JSON.stringify(refused);
		await call(
			'POST',
			'/api/v1/actions/core.installLanguagePackFromUrl',
			{ url: 'https://packs.example.com/en.json' },
			cookie,
		);
		await runtime.kernel.worker.drain();
		expect(
			(await call('GET', '/api/v1/core/languages/fetch', undefined, cookie)).body,
		).toMatchObject({
			status: 'failed',
			error: expect.stringMatching(/^The pack was refused: .+/),
		});
		// The job finished (no retry is waiting): draining again changes nothing.
		await runtime.kernel.worker.drain();
		expect(
			(await call('GET', '/api/v1/core/languages/fetch', undefined, cookie)).body,
		).toMatchObject({
			status: 'failed',
		});
	});

	it('only accepts https and reports a failed fetch in plain words', async () => {
		const { cookie } = await setupAdmin();
		expect(
			(
				await call(
					'POST',
					'/api/v1/actions/core.installLanguagePackFromUrl',
					{ url: 'http://packs.example.com/yy.json' },
					cookie,
				)
			).status,
		).toBe(400);

		fakeHttp.body = new ExternalHttpError('blocked_address', 'private address');
		await call(
			'POST',
			'/api/v1/actions/core.installLanguagePackFromUrl',
			{ url: 'https://10.0.0.1/pack.json' },
			cookie,
		);
		await runtime.kernel.worker.drain();
		const failed = (await call('GET', '/api/v1/core/languages/fetch', undefined, cookie)).body;
		expect(failed).toMatchObject({ status: 'failed', error: 'The address could not be fetched' });

		fakeHttp.body = 'this is not json';
		await call(
			'POST',
			'/api/v1/actions/core.installLanguagePackFromUrl',
			{ url: 'https://packs.example.com/nope.json' },
			cookie,
		);
		await runtime.kernel.worker.drain();
		expect(
			(await call('GET', '/api/v1/core/languages/fetch', undefined, cookie)).body,
		).toMatchObject({
			status: 'failed',
			error: 'The address did not return a language pack',
		});
	});
});

describe('people hear it in their language', () => {
	it('renders a notification in the member language, else the family language, else English', async () => {
		const { admin, cookie } = await setupAdmin('tr');
		// The setup language became the family language and the admin's own.
		expect(admin.locale).toBe('tr');
		await call(
			'POST',
			'/api/v1/actions/core.installLanguagePack',
			{ pack: tinyPack('xx') },
			cookie,
		);
		const kid = await addMember(cookie);
		await call(
			'POST',
			'/api/v1/actions/core.updateMember',
			{ memberId: kid.id, locale: 'xx' },
			cookie,
		);
		const translate = runtime.kernel.translate;
		expect(translate('xx', 'push_test_title')).toBe('Testtitel');
		// Missing from the pack: English, not Turkish and not the key.
		expect(translate('xx', 'nav_home')).toBe('Today');
		expect(translate('tr', 'nav_home')).not.toBe('Today');
	});
});

describe('backups carry installed packs', () => {
	it('archives languages/ and restores it', async () => {
		const { cookie } = await setupAdmin();
		await call(
			'POST',
			'/api/v1/actions/core.installLanguagePack',
			{ pack: tinyPack('xx') },
			cookie,
		);
		const { path } = await createBackup({
			sqlite: runtime.handle.sqlite,
			filesDir: runtime.config.filesDir,
			languagesDir: runtime.config.languagesDir,
			backupsDir: runtime.config.backupsDir,
			appVersion: APP_VERSION,
			schema: {},
			reason: 'manual',
		});
		const target = await mkdtemp(join(tmpdir(), 'famos-restore-'));
		await restoreBackup({
			file: path,
			dbPath: join(target, 'famos.db'),
			filesDir: join(target, 'files'),
			languagesDir: join(target, 'languages'),
		});
		expect(await readdir(join(target, 'languages'))).toEqual(['xx']);
		await rm(target, { recursive: true, force: true });
	});
});
