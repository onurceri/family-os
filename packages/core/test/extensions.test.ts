import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Actor,
	defineAction,
	defineCapability,
	defineExtension,
	type ExtensionDefinition,
	FamosError,
	parseManifest,
	SDK_VERSION,
	systemActor,
} from '@famos/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { restartRequested } from '../src/extension-install.ts';
import {
	type ExtensionPackage,
	type ExtensionPackagesPort,
	type IndexedPackage,
	readExtensionState,
	type StagedPackage,
	writeExtensionState,
} from '../src/extension-state.ts';
import { isExtensionRefusedError } from '../src/registry.ts';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const open: TestKernel[] = [];
afterEach(async () => {
	for (const k of open.splice(0)) await k.close();
});
async function kernel(options: Parameters<typeof createTestKernel>[0] = {}) {
	const k = await createTestKernel(options);
	open.push(k);
	return k;
}

const ext = (id: string, more: Partial<Parameters<typeof defineTestExtension>[0]> = {}) =>
	defineTestExtension({ id, ...more });

/**
 * A package port over these extensions; `always` ones cannot be uninstalled. Uploads are the
 * given staged packages, staged by their digest's first byte.
 */
function packages(
	list: { ext: ExtensionDefinition; always?: boolean }[],
	uploads: StagedPackage[] = [],
): ExtensionPackagesPort & { placed: string[] } {
	const placed: string[] = [];
	const all: ExtensionPackage[] = list.map(({ ext, always }) => ({
		id: ext.id,
		version: ext.manifest.version,
		always: always === true,
		manifest: parseManifest(ext.manifest),
		labels: { en: { name: ext.id, description: `The ${ext.id}` } },
	}));
	const staged = new Map<string, StagedPackage>();
	return {
		placed,
		list: () => all,
		async place(source) {
			if ('staged' in source) {
				const found = staged.get(source.staged);
				if (!found) throw new FamosError('not_found', source.staged);
				placed.push(`${found.id}@${found.version}`);
				return { ...found, always: false };
			}
			const found = all.find((p) => p.id === source.id);
			if (!found) throw new FamosError('not_found', source.id);
			placed.push(source.id);
			return found;
		},
		async stage(archive) {
			const found = uploads.find((u) => u.digest.startsWith(String(archive[0])));
			if (!found) throw new FamosError('bad_request', 'The package is not signed');
			staged.set(found.digest, found);
			return found;
		},
		staged: async (digest) => staged.get(digest),
	};
}

/** An upload as a port stages it: checked, with its signer. */
const upload = (def: ExtensionDefinition, digest: string, version = '0.0.0'): StagedPackage => ({
	digest,
	id: def.id,
	version,
	manifest: parseManifest({ ...def.manifest, version }),
	labels: { en: { name: def.id, description: `The ${def.id}` } },
	signer: { keyId: '0123456789abcdef', kind: 'official' },
});

describe('a kernel with extensions it may refuse', () => {
	it('starts without a refused extension and its dependents, and says why', async () => {
		const broken = ext('broken', { calls: ['core.noSuchAction'] });
		const leaning = ext('leaning', { dependsOn: ['broken'] });
		const fine = ext('fine');
		const k = await kernel({
			extensions: [broken, leaning, fine],
			refusable: ['broken', 'leaning'],
		});
		expect(k.registry.extensions.map((e) => e.id)).toEqual(['core', 'fine']);
		expect(k.refused).toEqual([
			{
				id: 'broken',
				version: '0.0.0',
				reason: expect.stringContaining('core.noSuchAction'),
				code: 'invalid',
			},
			{
				id: 'leaning',
				version: '0.0.0',
				reason: 'It needs "broken", which was refused',
				code: 'dependency_refused',
				params: { extensionId: 'broken' },
			},
		]);
	});

	it('refuses to start when an extension it must run is refused', async () => {
		await expect(
			kernel({ extensions: [ext('broken', { calls: ['core.noSuchAction'] })] }),
		).rejects.toThrow(/core\.noSuchAction/);
		// Also when only its dependent could be left out.
		await expect(
			kernel({
				extensions: [
					ext('broken', { calls: ['core.noSuchAction'] }),
					ext('leaning', { dependsOn: ['broken'] }),
				],
				refusable: ['leaning'],
			}),
		).rejects.toThrow(/core\.noSuchAction/);
	});

	it('names the extension behind a duplicate or an unknown capability', async () => {
		const action = (id: string) =>
			defineAction({
				id,
				title: id,
				input: z.object({}),
				output: z.object({}),
				readOnly: true,
				requires: 'nowhere.view',
				async run() {
					return {};
				},
			});
		const k = await kernel({
			extensions: [ext('stray', { actions: [action('stray.read')] }), ext('fine')],
			refusable: ['stray'],
		});
		expect(k.refused).toEqual([
			{
				id: 'stray',
				version: '0.0.0',
				reason: expect.stringContaining('nowhere.view'),
				code: 'invalid',
			},
		]);
	});

	it('gives a refusal a code and the values a page names, beside the words for the log', async () => {
		const future = defineExtension({ manifest: { id: 'future', version: '1.0.0', sdk: '^9.0.0' } });
		const lonely = ext('lonely', { dependsOn: ['nowhere'] });
		const k = await kernel({ extensions: [future, lonely], refusable: ['future', 'lonely'] });
		expect(k.refused).toEqual([
			expect.objectContaining({
				id: 'lonely',
				code: 'missing_dependency',
				params: { extensionId: 'nowhere' },
			}),
			expect.objectContaining({
				id: 'future',
				code: 'sdk',
				params: { needs: '^9.0.0', has: SDK_VERSION },
			}),
		]);
	});

	it('turns a failing start of an optional extension into a refusal the server records', async () => {
		const failing = ext('failing', {
			register: async () => {
				throw new Error('no luck');
			},
		});
		const error = await kernel({ extensions: [failing], refusable: ['failing'] }).catch(
			(e: unknown) => e,
		);
		expect(isExtensionRefusedError(error)).toBe(true);
		expect(error).toMatchObject({
			extensionId: 'failing',
			reason: 'Its start failed: no luck',
			code: 'start_failed',
		});
		// One that is always there fails as it is.
		await expect(kernel({ extensions: [failing] })).rejects.toThrow('no luck');
	});
});

describe('installing and uninstalling', () => {
	const notes = ext('notes');
	const records = ext('records');
	const pets = ext('pets', {
		dependsOn: ['records'],
		network: { hosts: ['vets.example.org'], local: true },
		capabilities: [defineCapability({ id: 'pets.view', label: 'pets:cap_view', level: 'view' })],
	});
	const port = () => packages([{ ext: notes, always: true }, { ext: records }, { ext: pets }]);

	async function admin(k: TestKernel) {
		return (await k.member('admin')).actor;
	}

	it('lists what runs and what can be installed, with what each reaches', async () => {
		const k = await kernel({ extensions: [notes], extensionPackages: port() });
		const list = await k.route('core.listExtensions').call({ actor: await admin(k) });
		expect(list.restartNeeded).toBe(false);
		expect(list.extensions).toEqual([
			expect.objectContaining({ id: 'notes', status: 'loaded', always: true }),
			expect.objectContaining({
				id: 'pets',
				status: 'available',
				always: false,
				dependsOn: ['records'],
				labels: { en: { name: 'pets', description: 'The pets' } },
				reaches: {
					hosts: ['vets.example.org'],
					userUrls: false,
					local: true,
					calls: [],
					capabilities: ['pets.view'],
				},
			}),
			expect.objectContaining({ id: 'records', status: 'available' }),
		]);
	});

	it('installs an extension with what it needs; it loads at the next start', async () => {
		const ports = port();
		const k = await kernel({ extensions: [notes], extensionPackages: ports });
		const actor = await admin(k);
		const result = await k.runner.invoke('core.installExtension', { extensionId: 'pets' }, actor);
		expect(result).toEqual({
			status: 'applied',
			output: { changed: ['records', 'pets'], restartNeeded: true },
		});
		expect(ports.placed).toEqual(['records', 'pets']);
		expect((await readExtensionState(k.ctx.db))?.installed).toEqual(['notes', 'pets', 'records']);
		const list = await k.route('core.listExtensions').call({ actor });
		expect(list.restartNeeded).toBe(true);
		expect(list.extensions.find((e: { id: string }) => e.id === 'pets').status).toBe(
			'pending_install',
		);
		// Installing it again changes nothing.
		await expect(
			k.runner.invoke('core.installExtension', { extensionId: 'pets' }, actor),
		).resolves.toMatchObject({ output: { changed: [] } });
	});

	it('refuses an install whose dependency this server lacks, and an unknown one', async () => {
		const lonely = ext('lonely', { dependsOn: ['nowhere'] });
		const k = await kernel({
			extensions: [notes],
			extensionPackages: packages([{ ext: notes, always: true }, { ext: lonely }]),
		});
		const actor = await admin(k);
		await expect(
			k.runner.invoke('core.installExtension', { extensionId: 'lonely' }, actor),
		).rejects.toMatchObject({ code: 'conflict', details: { reason: 'missing_dependency' } });
		await expect(
			k.runner.invoke('core.installExtension', { extensionId: 'ghost' }, actor),
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('refuses to uninstall what is always there, what another needs, and what is not installed', async () => {
		const k = await kernel({ extensions: [notes, records, pets], extensionPackages: port() });
		const actor = await admin(k);
		await expect(
			k.runner.invoke('core.uninstallExtension', { extensionId: 'notes' }, actor),
		).rejects.toMatchObject({ code: 'conflict', details: { reason: 'always' } });
		await expect(
			k.runner.invoke('core.uninstallExtension', { extensionId: 'records' }, actor),
		).rejects.toMatchObject({
			code: 'conflict',
			details: { reason: 'needed_by', neededBy: ['pets'] },
		});
		await expect(
			k.runner.invoke('core.uninstallExtension', { extensionId: 'pets' }, actor),
		).resolves.toMatchObject({ output: { changed: ['pets'], restartNeeded: true } });
		await expect(
			k.runner.invoke('core.uninstallExtension', { extensionId: 'pets' }, actor),
		).rejects.toMatchObject({ code: 'not_found' });
		const list = await k.route('core.listExtensions').call({ actor });
		expect(list.extensions.find((e: { id: string }) => e.id === 'pets').status).toBe(
			'pending_uninstall',
		);
	});

	it('remembers who asked for each change that waits for a restart, and when', async () => {
		const k = await kernel({ extensions: [notes, records, pets], extensionPackages: port() });
		const mara = await k.member('admin');
		const tom = await k.member('admin');
		const asked = k.clock.now();
		await k.runner.invoke('core.uninstallExtension', { extensionId: 'pets' }, mara.actor);
		k.clock.advance(1_000);
		const list = async (actor: Actor) =>
			(await k.route('core.listExtensions').call({ actor })).extensions as {
				id: string;
				changedBy: { memberId: string | null; at: number } | null;
			}[];
		// Every admin sees it, not only the one who asked.
		for (const actor of [mara.actor, tom.actor])
			expect((await list(actor)).find((e) => e.id === 'pets')?.changedBy).toEqual({
				memberId: mara.member.id,
				at: asked,
			});
		expect((await list(tom.actor)).find((e) => e.id === 'records')?.changedBy).toBeNull();
		// The other admin keeping it takes the request back: nobody is shown as having asked.
		await k.runner.invoke('core.installExtension', { extensionId: 'pets' }, tom.actor);
		expect((await list(mara.actor)).find((e) => e.id === 'pets')).toMatchObject({
			status: 'loaded',
			changedBy: null,
		});
		expect((await readExtensionState(k.ctx.db))?.changes).toEqual({});
		// A change asked on the command line has no member behind it.
		await k.runner.invoke('core.uninstallExtension', { extensionId: 'pets' }, systemActor('cli'));
		expect((await list(mara.actor)).find((e) => e.id === 'pets')?.changedBy).toEqual({
			memberId: null,
			at: k.clock.now(),
		});
	});

	it('clears a recorded failure when the family installs the package again', async () => {
		const k = await kernel({ extensions: [notes], extensionPackages: port() });
		await writeExtensionState(
			k.ctx.db,
			{
				installed: ['notes', 'records'],
				known: {},
				failed: [{ id: 'records', version: '0.0.0', reason: 'migration failed', at: 1 }],
				restartRequestedAt: null,
			},
			1,
		);
		const actor = await admin(k);
		const before = await k.route('core.listExtensions').call({ actor });
		expect(before.extensions.find((e: { id: string }) => e.id === 'records')).toMatchObject({
			status: 'failed',
			reason: 'migration failed',
		});
		await k.runner.invoke('core.installExtension', { extensionId: 'records' }, actor);
		expect((await readExtensionState(k.ctx.db))?.failed).toEqual([]);
	});

	it('records a restart request and tells the server', async () => {
		const k = await kernel({ extensions: [notes], extensionPackages: port() });
		const heard: number[] = [];
		k.bus.on(restartRequested, ({ at }) => void heard.push(at));
		const result = await k.runner.invoke('core.restartServer', {}, await admin(k));
		expect(result).toEqual({ status: 'applied', output: { requestedAt: k.clock.now() } });
		expect((await readExtensionState(k.ctx.db))?.restartRequestedAt).toBe(k.clock.now());
		await new Promise((r) => setTimeout(r, 0));
		expect(heard).toEqual([k.clock.now()]);
	});

	/** A file as an upload route receives it; its first byte picks the test port's upload. */
	const file = (first: number) => ({
		field: 'file',
		name: 'package.famext',
		type: 'application/octet-stream',
		size: 1,
		stream: async function* () {
			yield Uint8Array.of(first);
		},
		bytes: async () => Uint8Array.of(first),
	});
	const PETS_DIGEST = `1${'a'.repeat(31)}`;
	const RECORDS_DIGEST = `2${'b'.repeat(31)}`;

	it('stages an uploaded package, says what it is, and installs it with what it needs', async () => {
		const ports = packages(
			[{ ext: notes, always: true }, { ext: records }],
			[upload(pets, PETS_DIGEST, '1.0.0')],
		);
		const k = await kernel({ extensions: [notes], extensionPackages: ports });
		const actor = await admin(k);
		const staged = await k.route('core.uploadExtensionPackage').call({ actor, files: [file(1)] });
		expect(staged).toEqual({
			digest: PETS_DIGEST,
			id: 'pets',
			version: '1.0.0',
			current: null,
			labels: { en: { name: 'pets', description: 'The pets' } },
			dependsOn: ['records'],
			optional: [],
			reaches: {
				hosts: ['vets.example.org'],
				userUrls: false,
				local: true,
				calls: [],
				capabilities: ['pets.view'],
			},
			signer: { keyId: '0123456789abcdef', kind: 'official' },
		});
		// Nothing is installed by the upload itself.
		expect(ports.placed).toEqual([]);
		const result = await k.runner.invoke('core.installExtension', { staged: PETS_DIGEST }, actor);
		expect(result).toEqual({
			status: 'applied',
			output: { changed: ['records', 'pets'], restartNeeded: true },
		});
		expect(ports.placed).toEqual(['records', 'pets@1.0.0']);
		expect((await readExtensionState(k.ctx.db))?.installed).toEqual(['notes', 'pets', 'records']);
	});

	it('installs a newer version of a running extension, which loads at the next start', async () => {
		const ports = packages(
			[{ ext: notes, always: true }, { ext: records }],
			[upload(records, RECORDS_DIGEST, '0.2.0')],
		);
		const k = await kernel({ extensions: [notes, records], extensionPackages: ports });
		const actor = await admin(k);
		const staged = await k.route('core.uploadExtensionPackage').call({ actor, files: [file(2)] });
		expect(staged).toMatchObject({ id: 'records', version: '0.2.0', current: '0.0.0' });
		await expect(
			k.runner.invoke('core.installExtension', { staged: RECORDS_DIGEST }, actor),
		).resolves.toMatchObject({ output: { changed: ['records'] } });
		expect(ports.placed).toEqual(['records@0.2.0']);
	});

	it('shows a running extension whose next start brings another version', async () => {
		// The port lists what the next start loads: records 0.2.0, while 0.0.0 runs.
		const port: ExtensionPackagesPort = {
			list: () => [{ ...upload(records, RECORDS_DIGEST, '0.2.0'), always: false }],
			place: () => Promise.reject(new Error('not used')),
		};
		const k = await kernel({ extensions: [notes, records], extensionPackages: port });
		const list = await k.route('core.listExtensions').call({ actor: await admin(k) });
		expect(list.restartNeeded).toBe(true);
		expect(list.extensions.find((e: { id: string }) => e.id === 'records')).toMatchObject({
			status: 'loaded',
			version: '0.0.0',
			nextVersion: '0.2.0',
		});
		expect(list.extensions.find((e: { id: string }) => e.id === 'notes').nextVersion).toBeNull();
	});

	it('refuses an upload without a file, from anyone but a person, and where files cannot install', async () => {
		const k = await kernel({
			extensions: [notes],
			extensionPackages: packages([{ ext: notes, always: true }], [upload(pets, PETS_DIGEST)]),
		});
		const route = k.route('core.uploadExtensionPackage');
		await expect(route.call({ actor: await admin(k), files: [] })).rejects.toMatchObject({
			code: 'bad_request',
		});
		await expect(
			route.call({
				actor: { kind: 'display', deviceId: 'd', capabilities: [], showNames: false },
				files: [file(1)],
			}),
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			k.runner.invoke('core.installExtension', { staged: RECORDS_DIGEST }, await admin(k)),
		).rejects.toMatchObject({ code: 'not_found' });
		const without = await kernel({ extensions: [notes] });
		await expect(
			without
				.route('core.uploadExtensionPackage')
				.call({ actor: await admin(without), files: [file(1)] }),
		).rejects.toMatchObject({ code: 'bad_request' });
	});

	it('is for admins and the server alone: not other members, displays or any AI', async () => {
		const k = await kernel({ extensions: [notes], extensionPackages: port() });
		const member = (await k.member('member')).actor;
		const admin = (await k.member('admin')).actor;
		for (const id of ['core.installExtension', 'core.uninstallExtension', 'core.restartServer']) {
			const input = id === 'core.restartServer' ? {} : { extensionId: 'pets' };
			await expect(k.runner.invoke(id, input, member)).rejects.toMatchObject({
				code: 'forbidden',
			});
			await expect(
				k.runner.invoke(id, input, {
					kind: 'display',
					deviceId: 'd',
					capabilities: [],
					showNames: false,
				}),
			).rejects.toMatchObject({ code: 'forbidden' });
			// An agent with a member's token, acting for an admin: never, not even as a draft.
			await expect(
				k.runner.invoke(id, input, {
					kind: 'ai',
					mode: 'agent',
					source: 'mcp',
					onBehalfOf: admin.memberId,
					roleId: 'admin',
				}),
			).rejects.toMatchObject({ code: 'forbidden' });
		}
		// Not offered to any model either.
		const offered = [...k.ctx.actions.aiCatalog(), ...k.ctx.actions.aiReadTools()].map((a) => a.id);
		expect(offered.filter((id) => id.includes('Extension') || id.includes('restart'))).toEqual([]);
		// The capability is critical: no custom role can be given it.
		const caps = await k.route('core.listRoles').call({ actor: admin });
		expect(JSON.stringify(caps)).toContain('core.extensions.manage');
		await expect(
			k.runner.invoke('core.installExtension', { extensionId: 'pets' }, systemActor('cli')),
		).resolves.toMatchObject({ status: 'applied' });
	});
});

describe('an uninstalled extension', () => {
	const thingsEdit = defineCapability({
		id: 'things.edit',
		label: 'things:cap_edit',
		level: 'edit',
	});
	const things = ext('things', {
		capabilities: [thingsEdit],
		actions: [
			defineAction({
				id: 'things.addThing',
				title: 'Add a thing',
				input: z.object({ name: z.string() }),
				output: z.object({ ok: z.boolean() }),
				approval: { unless: thingsEdit.id },
				ai: { description: 'Adds a thing.' },
				async run() {
					return { ok: true };
				},
			}),
		],
	});

	it('keeps its drafts, which wait unseen by approvers and break nothing', async () => {
		const dbPath = join(await mkdtemp(join(tmpdir(), 'famos-uninstall-')), 'famos.db');
		const before = await createTestKernel({ dbPath, extensions: [things] });
		const admin = (await before.member('admin')).actor;
		const proposer = (await before.member('supervised')).actor;
		const fromAi = await before.ctx.actions.invoke(
			'things.addThing',
			{ name: 'kite' },
			{ kind: 'ai', mode: 'share', source: 'inbox' },
		);
		const fromMember = await before.ctx.actions.invoke(
			'things.addThing',
			{ name: 'ball' },
			proposer,
		);
		expect([fromAi.status, fromMember.status]).toEqual(['drafted', 'drafted']);
		await before.close();

		const after = await kernel({ dbPath });
		// Nobody can decide what nothing can apply: approvers do not see it and it is not counted…
		await expect(
			after.route('core.listDrafts').call({ actor: admin, query: { limit: 10 } }),
		).resolves.toEqual([]);
		await expect(after.route('core.countWaitingDrafts').call({ actor: admin })).resolves.toEqual({
			count: 0,
		});
		// …the person who proposed it still sees it…
		const own = await after
			.route('core.listDrafts')
			.call({ actor: proposer, query: { limit: 10 } });
		expect(own).toEqual([
			expect.objectContaining({ actionId: 'things.addThing', status: 'pending', canDecide: false }),
		]);
		// …approving it is refused, not a crash, and the AI is not offered the action.
		await expect(after.runner.approveDraft(own[0].id, admin)).rejects.toMatchObject({
			code: 'not_found',
		});
		expect(after.ctx.actions.aiCatalog().map((a) => a.id)).not.toContain('things.addThing');
		const rows = await after.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.select('status')
			.execute();
		expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
	});
});

describe('looking for more in the official index', () => {
	const notes = ext('notes');
	const garden = ext('garden');
	const GARDEN_DIGEST = `3${'c'.repeat(31)}`;
	const entry = (id: string, version: string, sdk = `^${SDK_VERSION}`): IndexedPackage => ({
		id,
		version,
		sdk,
		url: `https://index.example/extensions/${id}/${id}-${version}.famext`,
		sha256: 'f'.repeat(64),
		size: 1234,
		labels: { en: { name: id, description: `The ${id}` } },
	});

	/** The port of `packages` plus an index: `listed`, or the error `fail` gives. */
	function online(listed: IndexedPackage[], fail?: () => Error) {
		const base = packages([{ ext: notes, always: true }], [upload(garden, GARDEN_DIGEST, '1.1.0')]);
		const calls = { find: 0, download: [] as string[] };
		const port: ExtensionPackagesPort = {
			...base,
			async findPackages() {
				calls.find++;
				if (fail) throw fail();
				return listed;
			},
			async download(pkg) {
				calls.download.push(`${pkg.id}@${pkg.version}`);
				const staged = await base.stage?.(new Uint8Array([3]));
				if (!staged) throw new Error('not staged');
				return staged;
			},
		};
		return { port, calls };
	}
	const found = async (k: TestKernel) =>
		k.route('core.getFoundExtensions').call({ actor: (await k.member('admin')).actor });

	it('finds nothing until a person asks, then lists what this server lacks or has older', async () => {
		const { port, calls } = online([
			entry('garden', '1.0.0'),
			entry('garden', '1.1.0'),
			// Not newer than what the server has, and one it cannot run: neither is offered.
			entry('notes', '0.0.0'),
			entry('pond', '1.0.0', '^99.0.0'),
		]);
		const k = await kernel({ extensions: [notes], extensionPackages: port });
		await k.worker.drain();
		expect(calls.find).toBe(0);
		expect(await found(k)).toEqual({ search: null, found: [], download: null });

		const admin = (await k.member('admin')).actor;
		await expect(k.runner.invoke('core.findExtensions', {}, admin)).resolves.toMatchObject({
			status: 'applied',
		});
		expect(await found(k)).toMatchObject({ search: { status: 'looking' } });
		await k.worker.drain();
		expect(calls.find).toBe(1);
		expect(await found(k)).toEqual({
			search: { status: 'done', at: expect.any(Number), problem: null },
			found: [
				{
					id: 'garden',
					version: '1.1.0',
					current: null,
					size: 1234,
					labels: { en: { name: 'garden', description: 'The garden' } },
				},
			],
			download: null,
		});
		// Looking again: nothing is offered until the new search is done.
		await k.runner.invoke('core.findExtensions', {}, admin);
		expect(await found(k)).toMatchObject({ search: { status: 'looking' }, found: [] });
	});

	it('downloads a listed package into staging, which installs like a file', async () => {
		const { port, calls } = online([entry('garden', '1.1.0')]);
		const k = await kernel({ extensions: [notes], extensionPackages: port });
		const admin = (await k.member('admin')).actor;
		await k.runner.invoke('core.findExtensions', {}, admin);
		await k.worker.drain();
		await expect(
			k.runner.invoke('core.downloadExtension', { extensionId: 'garden', version: '9.9.9' }, admin),
		).rejects.toMatchObject({ code: 'not_found' });
		await k.runner.invoke(
			'core.downloadExtension',
			{ extensionId: 'garden', version: '1.1.0' },
			admin,
		);
		expect(await found(k)).toMatchObject({
			download: { id: 'garden', status: 'downloading', staged: null },
		});
		await k.worker.drain();
		expect(calls.download).toEqual(['garden@1.1.0']);
		expect((await found(k)).download).toMatchObject({
			id: 'garden',
			version: '1.1.0',
			status: 'ready',
			problem: null,
			staged: { digest: GARDEN_DIGEST, id: 'garden', version: '1.1.0', current: null },
		});
		await expect(
			k.runner.invoke('core.installExtension', { staged: GARDEN_DIGEST }, admin),
		).resolves.toMatchObject({ output: { changed: ['garden'], restartNeeded: true } });
	});

	it('records why looking or downloading failed, without trying again by itself', async () => {
		const unsigned = online(
			[],
			() =>
				new FamosError('bad_request', 'The index is signed with a key this server does not trust', {
					reason: 'unsigned',
				}),
		);
		const k = await kernel({ extensions: [notes], extensionPackages: unsigned.port });
		const admin = (await k.member('admin')).actor;
		await k.runner.invoke('core.findExtensions', {}, admin);
		await k.worker.drain();
		expect(unsigned.calls.find).toBe(1);
		expect((await found(k)).search).toEqual({
			status: 'failed',
			at: expect.any(Number),
			problem: { reason: 'unsigned', code: null, params: {} },
		});

		const { port } = online([entry('garden', '1.1.0')]);
		const refusing: ExtensionPackagesPort = {
			...port,
			download: () =>
				Promise.reject(
					new FamosError('bad_request', 'does not match', {
						reason: 'mismatch',
						path: 'garden-1.1.0.famext',
					}),
				),
		};
		const k2 = await kernel({ extensions: [notes], extensionPackages: refusing });
		const admin2 = (await k2.member('admin')).actor;
		await k2.runner.invoke('core.findExtensions', {}, admin2);
		await k2.worker.drain();
		await k2.runner.invoke(
			'core.downloadExtension',
			{ extensionId: 'garden', version: '1.1.0' },
			admin2,
		);
		await k2.worker.drain();
		expect((await found(k2)).download).toMatchObject({
			status: 'failed',
			staged: null,
			problem: { reason: 'mismatch', code: null, params: { path: 'garden-1.1.0.famext' } },
		});
	});

	it('is refused where the server cannot look online, and for anyone but a person', async () => {
		const k = await kernel({ extensions: [notes], extensionPackages: packages([{ ext: notes }]) });
		const admin = (await k.member('admin')).actor;
		await expect(k.runner.invoke('core.findExtensions', {}, admin)).rejects.toMatchObject({
			code: 'bad_request',
		});
		const { port } = online([]);
		const k2 = await kernel({ extensions: [notes], extensionPackages: port });
		const admin2 = (await k2.member('admin')).actor;
		const member = (await k2.member('member')).actor;
		const actors: Actor[] = [
			member,
			{ kind: 'display', deviceId: 'd', capabilities: [], showNames: false },
			{ kind: 'ai', mode: 'agent', source: 'mcp', onBehalfOf: admin2.memberId, roleId: 'admin' },
		];
		for (const actor of actors)
			await expect(k2.runner.invoke('core.findExtensions', {}, actor)).rejects.toMatchObject({
				code: 'forbidden',
			});
	});
});
