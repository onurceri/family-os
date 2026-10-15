import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	defineAction,
	defineCapability,
	type ExtensionDefinition,
	FamosError,
	parseManifest,
	systemActor,
} from '@famos/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { restartRequested } from '../src/extension-install.ts';
import {
	type ExtensionPackage,
	type ExtensionPackagesPort,
	readExtensionState,
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

/** A package port over these extensions; `always` ones cannot be uninstalled. */
function packages(
	list: { ext: ExtensionDefinition; always?: boolean }[],
): ExtensionPackagesPort & { placed: string[] } {
	const placed: string[] = [];
	const all: ExtensionPackage[] = list.map(({ ext, always }) => ({
		id: ext.id,
		version: ext.manifest.version,
		always: always === true,
		manifest: parseManifest(ext.manifest),
		labels: { en: { name: ext.id, description: `The ${ext.id}` } },
	}));
	return {
		placed,
		list: () => all,
		async place({ id }) {
			const found = all.find((p) => p.id === id);
			if (!found) throw new FamosError('not_found', id);
			placed.push(id);
			return found;
		},
	};
}

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
			{ id: 'broken', version: '0.0.0', reason: expect.stringContaining('core.noSuchAction') },
			{ id: 'leaning', version: '0.0.0', reason: 'It needs "broken", which was refused' },
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
			{ id: 'stray', version: '0.0.0', reason: expect.stringContaining('nowhere.view') },
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
		expect(error).toMatchObject({ extensionId: 'failing', reason: 'Its start failed: no luck' });
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
