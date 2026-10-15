import { randomBytes } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { silentLogger } from '@famos/adapters/runtime';
import { readExtensionState } from '@famos/core';
import { createBackup, openDatabase, restoreBackup, schemaState } from '@famos/db';
import { defineExtension, parseManifest, SDK_VERSION, systemActor } from '@famos/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { loadInstalled, recordStart } from '../src/extensions/installed.ts';
import type { Available, AvailableExtension } from '../src/extensions/load.ts';
import { createHttpApp } from '../src/http/app.ts';
import { ARCHIVE_LIMITS, readArchive } from '../src/packages/archive.ts';
import { createExtensionStore, type StoreScan, withStore } from '../src/packages/store.ts';
import { TRUST_ROOTS } from '../src/packages/trust.ts';
import { verifyPackage } from '../src/packages/verify.ts';
import { restoreFile } from '../src/restore.ts';
import { migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import {
	famext,
	handMade,
	OTHER_KEY,
	TEST_KEY,
	TEST_ROOTS,
	ustar,
	writePackage,
} from './support/packages.ts';

const scratch = mkdtempSync(join(tmpdir(), 'famos-store-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fresh = (name: string) => mkdtempSync(join(scratch, `${name}-`));

const stage = async (archive: Uint8Array) => verifyPackage(await readArchive(archive), TEST_ROOTS);

describe('a signed package', () => {
	const dir = writePackage(scratch, 'garden', '1.0.0');

	it('is accepted with its signer, manifest and digest', async () => {
		const pkg = await stage(await famext(dir));
		expect(pkg).toMatchObject({
			id: 'garden',
			version: '1.0.0',
			signer: { keyId: TEST_KEY.keyId, kind: 'official' },
			labels: { en: { name: 'garden', description: 'The garden' } },
		});
		expect(pkg.digest).toMatch(/^[0-9a-f]{32}$/);
		expect([...pkg.files.keys()].sort()).toEqual([
			'famos-package.json',
			'famos-package.sig',
			'messages/en.json',
			'server/index.mjs',
		]);
		// Packing is reproducible: the same folder gives the same bytes.
		expect((await famext(dir)).equals(await famext(dir))).toBe(true);
	});

	it('is refused when a file was changed after signing', async () => {
		await expect(
			stage(handMade(dir, { change: { 'server/index.mjs': 'export default {};\n' } })),
		).rejects.toThrow(/server\/index\.mjs does not match the hash/);
	});

	it('is refused when its description was changed after signing', async () => {
		const forged = handMade(dir, {
			change: {},
			add: [],
		});
		// Re-sign nothing, but swap the description for one that lists a different hash.
		const entries = (await readArchive(forged)) as Map<string, Buffer>;
		const description = JSON.parse(entries.get('famos-package.json')?.toString() ?? '{}');
		description.manifest.version = '9.9.9';
		const tampered = gzipSync(
			ustar(
				[...entries].map(([path, body]) => ({
					path,
					body: path === 'famos-package.json' ? JSON.stringify(description) : body,
				})),
			),
		);
		await expect(stage(tampered)).rejects.toThrow(/signature does not match/);
	});

	it('is refused when signed with a key the server does not trust', async () => {
		await expect(stage(await famext(dir, OTHER_KEY.privateKey))).rejects.toThrow(
			new RegExp(`a key this server does not trust \\(${OTHER_KEY.keyId}\\)`),
		);
	});

	it('is refused by a server that trusts no key yet (the shipped list is empty)', async () => {
		expect(TRUST_ROOTS).toEqual([]);
		const files = await readArchive(await famext(dir));
		expect(() => verifyPackage(files, TRUST_ROOTS)).toThrow(/does not trust/);
	});

	it('is refused without a signature', async () => {
		const unsigned = gzipSync(ustar([{ path: 'famos-package.json', body: '{}' }]));
		await expect(stage(unsigned)).rejects.toThrow(/not signed/);
	});

	it('is refused when it holds a file it does not list', async () => {
		await expect(
			stage(handMade(dir, { add: [{ path: 'server/extra.mjs', body: 'export {}' }] })),
		).rejects.toThrow(/holds server\/extra\.mjs, which it does not list/);
	});

	it.each([
		['a path that climbs out', '../evil.mjs'],
		['a path inside that climbs', 'server/../../evil.mjs'],
		['an absolute path', '/etc/evil'],
		['a backslash', 'server\\evil.mjs'],
	])('is refused with %s', async (_what, path) => {
		await expect(stage(handMade(dir, { add: [{ path, body: 'x' }] }))).rejects.toThrow(
			/unsafe path/,
		);
	});

	it.each([
		['a symbolic link', '2'],
		['a hard link', '1'],
		['a device', '3'],
	] as const)('is refused when it holds %s', async (_what, type) => {
		const archive = handMade(dir, {
			add: [{ path: 'server/link.mjs', type, ...(type !== '3' && { linkpath: '/etc/passwd' }) }],
		});
		await expect(stage(archive)).rejects.toThrow(/entry .*only files are allowed/);
	});

	it('is refused when it is too large, unpacks too far or holds too many files', async () => {
		await expect(readArchive(Buffer.alloc(ARCHIVE_LIMITS.compressedBytes + 1))).rejects.toThrow(
			/larger than 20 MB/,
		);
		// A few hundred kilobytes that would unpack to more than the limit.
		const bomb = gzipSync(
			ustar([{ path: 'big.bin', body: Buffer.alloc(ARCHIVE_LIMITS.unpackedBytes + 1) }]),
		);
		expect(bomb.byteLength).toBeLessThan(1024 * 1024);
		await expect(readArchive(bomb)).rejects.toThrow(/unpacks to more than 60 MB/);
		const many = gzipSync(
			ustar(
				Array.from({ length: ARCHIVE_LIMITS.files + 1 }, (_, i) => ({ path: `f/${i}`, body: '' })),
			),
		);
		await expect(readArchive(many)).rejects.toThrow(/more than 2000 files/);
		await expect(readArchive(randomBytes(100))).rejects.toThrow(/not gzip/);
	});

	it('is refused when it is named like the host or built for another platform', async () => {
		const reserved = writePackage(scratch, 'auth', '1.0.0');
		await expect(stage(await famext(reserved))).rejects.toThrow(/is the host's/);
		const old = writePackage(scratch, 'old', '1.0.0', { built: '0.0.1' });
		await expect(stage(await famext(old))).rejects.toThrow(/built for platform 0\.0\.1/);
	});
});

describe('the store', () => {
	it('stages, places and finds a package again, checking it each time', async () => {
		const store = createExtensionStore({ dir: fresh('store'), trustRoots: TEST_ROOTS });
		const staged = await store.stage(await famext(writePackage(scratch, 'garden', '1.0.0')));
		expect(await store.staged(staged.digest)).toMatchObject({ id: 'garden', version: '1.0.0' });
		expect((await store.scan()).copies).toEqual([]);
		await store.place(staged.digest);
		// Placing again (an install run twice) is the same.
		await store.place(staged.digest);
		expect(await store.staged(staged.digest)).toBeUndefined();
		const { copies, refused } = await store.scan();
		expect(refused).toEqual([]);
		expect(copies.map((c) => [c.extension.id, c.digest, c.signer.kind])).toEqual([
			['garden', staged.digest, 'official'],
		]);
		expect(existsSync(join(store.dir, 'garden', staged.digest, 'famos-package.sig'))).toBe(true);
	});

	it('refuses a stored copy that changed, gained a file or a link since it was placed', async () => {
		const dir = fresh('store');
		const store = createExtensionStore({ dir, trustRoots: TEST_ROOTS });
		const place = async (id: string) => {
			const staged = await store.stage(await famext(writePackage(scratch, id, '1.0.0')));
			await store.place(staged.digest);
			return join(dir, id, staged.digest);
		};
		appendFileSync(join(await place('changed'), 'server/index.mjs'), '// more\n');
		writeFileSync(join(await place('grown'), 'server/extra.mjs'), 'export {}\n');
		symlinkSync('/etc/passwd', join(await place('linked'), 'server/link.mjs'));
		const fine = await place('fine');
		const { copies, refused } = await store.scan();
		expect(copies.map((c) => c.extension.id)).toEqual(['fine']);
		expect(Object.fromEntries(refused.map((r) => [r.id, r.reason]))).toEqual({
			changed: expect.stringMatching(/does not match the hash/),
			grown: expect.stringMatching(/does not list/),
			linked: expect.stringMatching(/not a file/),
		});
		// A server that does not trust the key (yet) uses none of it.
		const untrusting = createExtensionStore({ dir, trustRoots: [] });
		expect((await untrusting.scan()).copies).toEqual([]);
		expect(existsSync(fine)).toBe(true);
	});

	it('removes old copies, keeping the running one and the one before, and stale uploads', async () => {
		const dir = fresh('store');
		const store = createExtensionStore({ dir, trustRoots: TEST_ROOTS });
		const digests: string[] = [];
		for (const [i, version] of ['1.0.0', '1.1.0', '1.2.0', '1.3.0'].entries()) {
			const staged = await store.stage(await famext(writePackage(scratch, 'garden', version)));
			await store.place(staged.digest);
			const at = new Date(Date.UTC(2026, 0, 1 + i));
			utimesSync(join(dir, 'garden', staged.digest), at, at);
			digests.push(staged.digest);
		}
		const waiting = await store.stage(await famext(writePackage(scratch, 'pond', '1.0.0')));
		const [first, second, third, fourth] = digests as [string, string, string, string];
		// 1.1.0 runs (say the newer ones were refused); 1.3.0 is the newest other one.
		const removed = await store.collect(new Map([['garden', second]]));
		expect(removed.sort()).toEqual([`garden/${first}`, `garden/${third}`].sort());
		expect(readdirSync(join(dir, 'garden')).sort()).toEqual([second, fourth].sort());
		expect(await store.staged(waiting.digest)).toBeDefined();
		// A day later the upload nobody installed is gone too.
		expect(await store.collect(new Map(), Date.now() + 25 * 60 * 60 * 1000)).toEqual([
			`garden/${second}`,
			`.staging/${waiting.digest}`,
		]);
	});
});

/** An extension at hand, as the server finds a shipped one. */
function shipped(id: string, version: string, always = false): AvailableExtension {
	const manifest = parseManifest({ id, version, sdk: `^${SDK_VERSION}` });
	return {
		id,
		version,
		always,
		manifest,
		labels: { en: { name: id, description: id } },
		load: async () => defineExtension({ manifest }),
		web: () => undefined,
	};
}
const availableOf = (...extensions: AvailableExtension[]): Available => ({
	from: 'bundled',
	dir: '/nonexistent',
	list: { always: extensions.filter((e) => e.always).map((e) => e.id), offered: [], default: [] },
	extensions,
	unreadable: [],
});
const copy = (
	id: string,
	version: string,
	digest: string,
	placedAt = 1,
): StoreScan['copies'][0] => ({
	extension: shipped(id, version),
	digest,
	dir: `/store/${id}/${digest}`,
	signer: { keyId: TEST_KEY.keyId, kind: 'official' },
	placedAt,
});

describe('choosing a copy', () => {
	it('takes the highest version; a shipped copy wins a tie and keeps its always', () => {
		const chosen = withStore(
			availableOf(
				shipped('garden', '1.0.0', true),
				shipped('pond', '2.0.0'),
				shipped('lawn', '1.0.0'),
			),
			{
				copies: [
					copy('garden', '1.1.0', 'a'),
					copy('pond', '1.9.0', 'b'),
					copy('lawn', '1.0.0', 'c'),
					copy('shed', '0.1.0', 'd'),
				],
				refused: [],
			},
		);
		const by = Object.fromEntries(chosen.extensions.map((e) => [e.id, e]));
		// A newer stored copy updates a shipped extension, and stays always installed.
		expect(by.garden).toMatchObject({ version: '1.1.0', always: true, stored: { digest: 'a' } });
		// A newer shipped copy (a new image) replaces an older stored one.
		expect(by.pond).toMatchObject({ version: '2.0.0' });
		expect(by.pond?.stored).toBeUndefined();
		expect(by.lawn?.stored).toBeUndefined();
		expect(by.shed).toMatchObject({ version: '0.1.0', always: false, stored: { digest: 'd' } });
	});

	it('takes the later placed of two stored copies of one version', () => {
		const chosen = withStore(availableOf(), {
			copies: [copy('shed', '1.0.0', 'late', 5), copy('shed', '1.0.0', 'early', 1)],
			refused: [],
		});
		expect(chosen.extensions.map((e) => e.stored?.digest)).toEqual(['late']);
	});
});

const runtimes: Runtime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
});

/** One start of the server on `dataDir`, with its store checked as `main` does. */
async function start(dataDir: string, bundled: AvailableExtension[] = []) {
	const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: 'http://localhost' });
	const store = createExtensionStore({ dir: config.extensionsDir, trustRoots: TEST_ROOTS });
	const scan = await store.scan();
	const handle = openDatabase({ path: config.dbPath });
	const selection = await loadInstalled(handle.db, withStore(availableOf(...bundled), scan), {
		store,
	});
	const runtime = openRuntime(config, {
		extensions: selection.extensions,
		handle,
		extensionPackages: selection.packages,
		refusable: selection.refusable,
		refused: selection.refused,
		logger: silentLogger,
		quiet: true,
		passwordHasher: fastPasswordHasher,
	});
	runtimes.push(runtime);
	await migrate(runtime);
	await recordStart(handle.db, selection, runtime.kernel.registry.extensions, Date.now());
	return { runtime, selection, store, scan, config };
}
async function stop(runtime: Runtime) {
	runtimes.splice(runtimes.indexOf(runtime), 1);
	await runtime.close();
}
const cli = systemActor('cli');
const loadedIds = (runtime: Runtime) =>
	runtime.kernel.registry.extensions.map((e) => e.id).filter((id) => id !== 'core');

describe('installing from a file', () => {
	it('stages, installs and loads the package at the next start, checked again', async () => {
		const dataDir = fresh('data');
		const first = await start(dataDir);
		const stage = first.selection.packages.stage;
		if (!stage) throw new Error('the port stages');
		const staged = await stage(await famext(writePackage(scratch, 'garden', '1.0.0')));
		const listed = await first.runtime.kernel.runner.invoke(
			'core.installExtension',
			{ staged: staged.digest },
			cli,
		);
		expect(listed).toMatchObject({ output: { changed: ['garden'], restartNeeded: true } });
		const pending = await first.runtime.kernel.listExtensions();
		expect(pending.extensions.find((e) => e.id === 'garden')).toMatchObject({
			status: 'pending_install',
			version: '1.0.0',
		});
		await stop(first.runtime);

		const second = await start(dataDir);
		expect(loadedIds(second.runtime)).toEqual(['garden']);
		expect(second.selection.storedInUse).toEqual(new Map([['garden', staged.digest]]));
		await stop(second.runtime);

		// Changed on disk: refused at the next start, and the rest of the server starts.
		appendFileSync(
			join(second.config.extensionsDir, 'garden', staged.digest, 'server/index.mjs'),
			' ',
		);
		const third = await start(dataDir);
		expect(third.scan.refused).toEqual([
			expect.objectContaining({ id: 'garden', reason: expect.stringMatching(/hash/) }),
		]);
		expect(loadedIds(third.runtime)).toEqual([]);
		expect(third.runtime.kernel.refused).toEqual([
			expect.objectContaining({ id: 'garden', reason: 'This server has no package of it' }),
		]);
		expect((await readExtensionState(third.runtime.handle.db))?.installed).toEqual(['garden']);
	});

	it('updates a running extension; refuses an older version than the server has', async () => {
		const dataDir = fresh('data');
		const bundled = [shipped('garden', '1.0.0')];
		const first = await start(dataDir, bundled);
		const stage = first.selection.packages.stage;
		if (!stage) throw new Error('the port stages');
		await expect(
			stage(await famext(writePackage(scratch, 'garden', '0.9.0'))),
		).rejects.toMatchObject({
			code: 'conflict',
			details: { reason: 'older', version: '1.0.0' },
		});
		const staged = await stage(await famext(writePackage(scratch, 'garden', '1.1.0')));
		await first.runtime.kernel.runner.invoke(
			'core.installExtension',
			{ staged: staged.digest },
			cli,
		);
		await stop(first.runtime);
		const second = await start(dataDir, bundled);
		expect(
			second.runtime.kernel.registry.extensions.find((e) => e.id === 'garden')?.manifest.version,
		).toBe('1.1.0');
		// A new image that ships 1.2.0 replaces the stored 1.1.0.
		await stop(second.runtime);
		const third = await start(dataDir, [shipped('garden', '1.2.0')]);
		expect(third.selection.storedInUse).toEqual(new Map());
		expect(third.selection.extensions.find((e) => e.id === 'garden')?.manifest.version).toBe(
			'1.2.0',
		);
	});
});

describe('backups', () => {
	it('carry the store, and restoring brings its packages back', async () => {
		const dataDir = fresh('data');
		const first = await start(dataDir);
		const stage = first.selection.packages.stage;
		if (!stage) throw new Error('the port stages');
		const staged = await stage(await famext(writePackage(scratch, 'garden', '1.0.0')));
		await first.runtime.kernel.runner.invoke(
			'core.installExtension',
			{ staged: staged.digest },
			cli,
		);
		// An upload nobody installed is not part of the backup.
		const waiting = await stage(await famext(writePackage(scratch, 'pond', '1.0.0')));
		const { config, runtime } = first;
		const { path } = await createBackup({
			sqlite: runtime.handle.sqlite,
			filesDir: config.filesDir,
			extensionsDir: config.extensionsDir,
			backupsDir: config.backupsDir,
			appVersion: '0.0.0',
			schema: await schemaState(runtime.handle.db),
			reason: 'manual',
		});
		await stop(runtime);

		const elsewhere = fresh('restored');
		const target = await loadConfig({
			FAMOS_DATA_DIR: elsewhere,
			FAMOS_BASE_URL: 'http://localhost',
		});
		await restoreFile(target, path, { extensions: [] });
		expect(readdirSync(target.extensionsDir)).toEqual(['garden']);
		expect(existsSync(join(target.extensionsDir, '.staging', waiting.digest))).toBe(false);
		const again = await start(elsewhere);
		expect(loadedIds(again.runtime)).toEqual(['garden']);
	});

	it('from before the store restore, and an installed package they lack is left out', async () => {
		const dataDir = fresh('data');
		const first = await start(dataDir);
		const stage = first.selection.packages.stage;
		if (!stage) throw new Error('the port stages');
		const staged = await stage(await famext(writePackage(scratch, 'garden', '1.0.0')));
		await first.runtime.kernel.runner.invoke(
			'core.installExtension',
			{ staged: staged.digest },
			cli,
		);
		const { config, runtime } = first;
		// Written as a release without the store did: no `extensions/` in it.
		const { path } = await createBackup({
			sqlite: runtime.handle.sqlite,
			filesDir: config.filesDir,
			backupsDir: config.backupsDir,
			appVersion: '0.0.0',
			schema: await schemaState(runtime.handle.db),
			reason: 'manual',
		});
		await stop(runtime);

		const elsewhere = fresh('restored');
		const target = await loadConfig({
			FAMOS_DATA_DIR: elsewhere,
			FAMOS_BASE_URL: 'http://localhost',
		});
		await restoreBackup({
			file: path,
			dbPath: target.dbPath,
			filesDir: target.filesDir,
			extensionsDir: target.extensionsDir,
		});
		expect(existsSync(target.extensionsDir)).toBe(false);
		const again = await start(elsewhere);
		expect(loadedIds(again.runtime)).toEqual([]);
		expect(again.runtime.kernel.refused).toEqual([
			expect.objectContaining({ id: 'garden', reason: 'This server has no package of it' }),
		]);
	});
});

describe('the upload route', () => {
	const BASE = 'http://localhost:3000';

	it('takes a .famext from an admin, says what it is, and installs it by its digest', async () => {
		const { runtime } = await start(fresh('data'));
		await runtime.kernel.start();
		const app = createHttpApp({
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
			appVersion: '0.0.0',
			secureCookies: false,
		});
		const post = (path: string, body: string | FormData, headers: Record<string, string> = {}) =>
			app.request(`${BASE}${path}`, {
				method: 'POST',
				headers: { origin: BASE, ...headers },
				body,
			});
		const json = { 'content-type': 'application/json' };
		await post(
			'/api/v1/core/setup',
			JSON.stringify({
				displayName: 'P',
				email: 'p@example.com',
				password: 'correct horse battery',
				locale: 'en',
				setupCode: runtime.config.setupCode,
			}),
			json,
		);
		const signIn = await post(
			'/api/auth/sign-in/email',
			JSON.stringify({ email: 'p@example.com', password: 'correct horse battery' }),
			json,
		);
		const cookie = signIn.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ');
		const form = (bytes: Uint8Array) => {
			const body = new FormData();
			body.append('files', new File([new Uint8Array(bytes)], 'garden-1.0.0.famext'));
			return body;
		};
		const archive = await famext(writePackage(scratch, 'garden', '1.0.0'));

		const anonymous = await post('/api/v1/core/extensions/packages', form(archive));
		expect(anonymous.status).toBe(401);
		const res = await post('/api/v1/core/extensions/packages', form(archive), { cookie });
		expect(res.status).toBe(201);
		const staged = (await res.json()) as { digest: string };
		expect(staged).toMatchObject({
			id: 'garden',
			version: '1.0.0',
			current: null,
			signer: { keyId: TEST_KEY.keyId, kind: 'official' },
		});
		const installed = await post(
			'/api/v1/actions/core.installExtension',
			JSON.stringify({ staged: staged.digest }),
			{ ...json, cookie },
		);
		expect(installed.status).toBe(200);
		expect(await installed.json()).toMatchObject({
			status: 'applied',
			output: { changed: ['garden'], restartNeeded: true },
		});

		const unsigned = await post(
			'/api/v1/core/extensions/packages',
			form(await famext(writePackage(scratch, 'pond', '1.0.0'), OTHER_KEY.privateKey)),
			{ cookie },
		);
		expect(unsigned.status).toBe(400);
		expect(await unsigned.json()).toMatchObject({
			error: { message: expect.stringMatching(/does not trust/) },
		});
		const huge = await post(
			'/api/v1/core/extensions/packages',
			form(new Uint8Array(ARCHIVE_LIMITS.compressedBytes + 128 * 1024)),
			{ cookie },
		);
		expect(huge.status).toBe(413);
	});
});
