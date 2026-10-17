import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@famos/adapters/runtime';
import type { IndexedPackage } from '@famos/core';
import { openDatabase } from '@famos/db';
import { signFile, writeIndex } from '@famos/pack/famext';
import { systemActor } from '@famos/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { loadInstalled, recordStart } from '../src/extensions/installed.ts';
import type { Available } from '../src/extensions/load.ts';
import { createHttpApp } from '../src/http/app.ts';
import {
	downloadPackage,
	type Fetch,
	fetchIndex,
	INDEX_LIMITS,
	OFFICIAL_INDEX_URL,
} from '../src/packages/official.ts';
import { createExtensionStore, withStore } from '../src/packages/store.ts';
import { migrate, openRuntime, type Runtime } from '../src/runtime.ts';
import { fastPasswordHasher } from './fast-password.ts';
import { famext, OTHER_KEY, TEST_KEY, TEST_ROOTS, writePackage } from './support/packages.ts';

const scratch = mkdtempSync(join(tmpdir(), 'famos-index-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fresh = (name: string) => mkdtempSync(join(scratch, `${name}-`));

const HOST = 'https://index.test';
const INDEX_URL = `${HOST}/extensions/index.json`;

/**
 * A published folder as the release workflow writes it (the packages, `index.json` and its
 * signature), served by a fake `fetch` under `https://index.test/extensions/`. No network: every
 * request is answered from the folder, or by `answer` when a test wants something else.
 */
async function publish(
	packages: { id: string; version: string; sdk?: string }[],
	options: { signWith?: string } = {},
) {
	const dir = fresh('pages');
	const add: string[] = [];
	for (const { id, version, sdk } of packages) {
		const folder = writePackage(
			scratch,
			id,
			version,
			sdk ? { manifest: { id, version, sdk } } : {},
		);
		const file = join(fresh('packed'), `${id}-${version}.famext`);
		writeFileSync(file, await famext(folder));
		add.push(file);
	}
	await writeIndex(dir, { add });
	await signFile(
		join(dir, 'index.json'),
		createPrivateKey(options.signWith ?? TEST_KEY.privateKey),
	);
	const calls: { url: string; redirect: RequestInit['redirect'] }[] = [];
	const answers = new Map<string, () => Response>();
	const fetch: Fetch = async (url, init) => {
		calls.push({ url: url.href, redirect: init.redirect });
		const answer = answers.get(url.href);
		if (answer) return answer();
		if (!url.href.startsWith(`${HOST}/extensions/`)) return new Response('', { status: 404 });
		try {
			return new Response(readFileSync(join(dir, url.pathname.slice('/extensions/'.length))));
		} catch {
			return new Response('not found', { status: 404 });
		}
	};
	return { dir, fetch, calls, answers };
}

const official = (fetch: Fetch) => ({ url: INDEX_URL, trustRoots: TEST_ROOTS, fetch });

describe('the official index', () => {
	it('is at the project address, on https', () => {
		expect(OFFICIAL_INDEX_URL).toBe('https://onurceri.github.io/family-os/extensions/index.json');
	});

	it('is read when its signature is by a trusted key, with absolute package addresses', async () => {
		const site = await publish([
			{ id: 'garden', version: '1.0.0' },
			{ id: 'garden', version: '1.1.0' },
		]);
		const listed = await fetchIndex(official(site.fetch));
		expect(listed.map((p) => `${p.id}@${p.version}`)).toEqual(['garden@1.1.0', 'garden@1.0.0']);
		expect(listed[0]).toMatchObject({
			url: `${HOST}/extensions/garden/garden-1.1.0.famext`,
			sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			labels: { en: { name: 'garden', description: 'The garden' } },
		});
		// Plain requests to the index's host, never following a redirect.
		expect(site.calls).toEqual([
			{ url: INDEX_URL, redirect: 'manual' },
			{ url: `${INDEX_URL}.sig`, redirect: 'manual' },
		]);
	});

	it('is refused when signed by a key the server does not trust', async () => {
		const site = await publish([{ id: 'garden', version: '1.0.0' }], {
			signWith: OTHER_KEY.privateKey,
		});
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			message: expect.stringMatching(/does not trust/),
			details: { reason: 'unsigned' },
		});
	});

	it('is refused when it was changed after it was signed, or has no signature', async () => {
		const site = await publish([{ id: 'garden', version: '1.0.0' }]);
		const index = join(site.dir, 'index.json');
		writeFileSync(index, readFileSync(index, 'utf8').replace('"garden"', '"meadow"'));
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'unsigned' },
		});
		rmSync(`${index}.sig`);
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'unsigned' },
		});
	});

	it('is refused when it redirects, answers with an error, or is not https', async () => {
		const site = await publish([{ id: 'garden', version: '1.0.0' }]);
		site.answers.set(
			INDEX_URL,
			() => new Response('', { status: 302, headers: { location: 'https://elsewhere.test/i' } }),
		);
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			message: expect.stringMatching(/redirect, which is not followed/),
			details: { reason: 'unreachable' },
		});
		site.answers.set(INDEX_URL, () => new Response('', { status: 500 }));
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'unreachable' },
		});
		// No index published there (yet): the host answered, so it is not this server's connection.
		site.answers.set(INDEX_URL, () => new Response('', { status: 404 }));
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'missing' },
		});
		site.answers.set(INDEX_URL, () => new Response('', { status: 410 }));
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'missing' },
		});
		site.answers.set(INDEX_URL, () => new Response('', { status: 503 }));
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'unreachable' },
		});
		site.answers.set(INDEX_URL, () => {
			throw new TypeError('fetch failed');
		});
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'unreachable' },
		});
		await expect(
			fetchIndex({ ...official(site.fetch), url: 'http://index.test/extensions/index.json' }),
		).rejects.toMatchObject({ details: { reason: 'unreachable' } });
	});

	it('is refused when it is larger than the cap, whatever its headers say', async () => {
		const site = await publish([]);
		const huge = new Uint8Array(INDEX_LIMITS.indexBytes + 1);
		site.answers.set(INDEX_URL, () => new Response(huge));
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'invalid' },
		});
		// No length given: it is counted as it arrives.
		site.answers.set(
			INDEX_URL,
			() =>
				new Response(
					new ReadableStream({
						pull(controller) {
							controller.enqueue(new Uint8Array(64 * 1024));
						},
					}),
				),
		);
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'invalid' },
		});
	});

	it('is refused when it is not an index this server reads', async () => {
		const site = await publish([]);
		const index = join(site.dir, 'index.json');
		writeFileSync(index, '{"format":2,"extensions":[]}\n');
		await signFile(index, createPrivateKey(TEST_KEY.privateKey));
		await expect(fetchIndex(official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'invalid' },
		});
	});

	it('leaves out a package whose address is on another host', async () => {
		const site = await publish([{ id: 'garden', version: '1.0.0' }]);
		const index = join(site.dir, 'index.json');
		const parsed = JSON.parse(readFileSync(index, 'utf8'));
		parsed.extensions.push({
			...parsed.extensions[0],
			version: '2.0.0',
			url: 'https://elsewhere.test/garden-2.0.0.famext',
		});
		writeFileSync(index, JSON.stringify(parsed));
		await signFile(index, createPrivateKey(TEST_KEY.privateKey));
		expect((await fetchIndex(official(site.fetch))).map((p) => p.version)).toEqual(['1.0.0']);
	});
});

describe('downloading a package the index lists', () => {
	async function listed() {
		const site = await publish([{ id: 'garden', version: '1.0.0' }]);
		const [entry] = await fetchIndex(official(site.fetch));
		if (!entry) throw new Error('listed');
		return { site, entry };
	}

	it('gives the file when its size and hash are the index’s', async () => {
		const { site, entry } = await listed();
		const bytes = await downloadPackage(entry, official(site.fetch));
		expect(Buffer.from(bytes)).toEqual(readFileSync(join(site.dir, 'garden/garden-1.0.0.famext')));
	});

	it('is refused when the file differs from the index, is larger, or is elsewhere', async () => {
		const { site, entry } = await listed();
		const changed: IndexedPackage = { ...entry, sha256: '0'.repeat(64) };
		await expect(downloadPackage(changed, official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'mismatch' },
		});
		await expect(
			downloadPackage({ ...entry, size: entry.size - 1 }, official(site.fetch)),
		).rejects.toMatchObject({ details: { reason: 'mismatch' } });
		await expect(
			downloadPackage({ ...entry, size: entry.size + 1 }, official(site.fetch)),
		).rejects.toMatchObject({ details: { reason: 'mismatch' } });
		await expect(
			downloadPackage(
				{ ...entry, url: 'https://elsewhere.test/garden-1.0.0.famext' },
				official(site.fetch),
			),
		).rejects.toMatchObject({ details: { reason: 'unreachable' } });
		site.answers.set(entry.url, () => new Response('', { status: 301 }));
		await expect(downloadPackage(entry, official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'unreachable' },
		});
		site.answers.set(entry.url, () => new Response('', { status: 404 }));
		await expect(downloadPackage(entry, official(site.fetch))).rejects.toMatchObject({
			details: { reason: 'missing' },
		});
	});
});

describe('Look for more, end to end', () => {
	const BASE = 'http://localhost:3000';
	const runtimes: Runtime[] = [];
	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) await runtime.close();
	});

	const nothingShipped: Available = {
		from: 'bundled',
		dir: '/nonexistent',
		list: { always: [], offered: [], default: [] },
		extensions: [],
		unreadable: [],
	};

	async function start(dataDir: string, fetch: Fetch) {
		const config = await loadConfig({ FAMOS_DATA_DIR: dataDir, FAMOS_BASE_URL: BASE });
		const store = createExtensionStore({ dir: config.extensionsDir, trustRoots: TEST_ROOTS });
		const handle = openDatabase({ path: config.dbPath });
		const selection = await loadInstalled(
			handle.db,
			withStore(nothingShipped, await store.scan()),
			{ store, official: official(fetch) },
		);
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
		return { runtime, app, config };
	}

	it('finds, downloads, installs and runs a package from a signed index', async () => {
		const site = await publish([
			{ id: 'garden', version: '1.0.0' },
			{ id: 'garden', version: '1.1.0' },
			// One this server cannot run is not offered.
			{ id: 'pond', version: '1.0.0', sdk: '^99.0.0' },
		]);
		const dataDir = fresh('data');
		const { runtime, app, config } = await start(dataDir, site.fetch);
		const json = { 'content-type': 'application/json' };
		const request = (method: string, path: string, body?: unknown, cookie = '') =>
			app.request(`${BASE}${path}`, {
				method,
				headers: { origin: BASE, ...json, ...(cookie && { cookie }) },
				...(body !== undefined && { body: JSON.stringify(body) }),
			});
		await request('POST', '/api/v1/core/setup', {
			displayName: 'P',
			email: 'p@example.com',
			password: 'correct horse battery',
			locale: 'en',
			setupCode: config.setupCode,
		});
		const signIn = await request('POST', '/api/auth/sign-in/email', {
			email: 'p@example.com',
			password: 'correct horse battery',
		});
		const cookie = signIn.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ');
		const found = async () =>
			(await (await request('GET', '/api/v1/core/extensions/found', undefined, cookie)).json()) as {
				search: { status: string } | null;
				found: { id: string; version: string }[];
				download: { status: string; staged: { digest: string; signer: unknown } | null } | null;
			};

		// Nothing is fetched until someone asks.
		await runtime.kernel.worker.drain();
		expect(site.calls).toEqual([]);
		expect((await request('GET', '/api/v1/core/extensions/found')).status).toBe(401);

		const look = await request('POST', '/api/v1/actions/core.findExtensions', {}, cookie);
		expect(look.status).toBe(200);
		await runtime.kernel.worker.drain();
		expect(await found()).toMatchObject({
			search: { status: 'done' },
			found: [{ id: 'garden', version: '1.1.0' }],
			download: null,
		});

		await request(
			'POST',
			'/api/v1/actions/core.downloadExtension',
			{ extensionId: 'garden', version: '1.1.0' },
			cookie,
		);
		await runtime.kernel.worker.drain();
		const ready = await found();
		expect(ready.download).toMatchObject({
			status: 'ready',
			staged: { id: 'garden', version: '1.1.0', signer: { keyId: TEST_KEY.keyId } },
		});
		const digest = ready.download?.staged?.digest;
		const installed = await request(
			'POST',
			'/api/v1/actions/core.installExtension',
			{ staged: digest },
			cookie,
		);
		expect(await installed.json()).toMatchObject({
			status: 'applied',
			output: { changed: ['garden'], restartNeeded: true },
		});
		// Placed: the server has it now, so it is no longer offered as found.
		expect((await found()).found).toEqual([]);
		runtimes.splice(runtimes.indexOf(runtime), 1);
		await runtime.close();

		const next = await start(dataDir, site.fetch);
		expect(
			next.runtime.kernel.registry.extensions.map((e) => `${e.id}@${e.manifest.version}`),
		).toContain('garden@1.1.0');
	});

	it('looks nowhere but the index it was given', async () => {
		const site = await publish([]);
		const { runtime } = await start(fresh('data'), site.fetch);
		await runtime.kernel.runner.invoke('core.findExtensions', {}, systemActor('cli'));
		await runtime.kernel.worker.drain();
		expect(site.calls.map((c) => new URL(c.url).origin)).toEqual([HOST, HOST]);
	});
});
