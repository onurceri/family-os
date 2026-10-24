import {
	type Actor,
	DigestInputSchema,
	type DigestOutput,
	DigestOutputSchema,
	defineAction,
	defineCapability,
	defineDigest,
	digestOf,
	type MemberId,
	systemActor,
} from '@famos/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRegistry } from '../src/registry.ts';
import { notesExtension } from './fixtures.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const view = (id: string) =>
	defineCapability({ id: `${id}.view`, label: `${id}:cap_view`, level: 'view' });
const vehiclesView = view('vehicles');
const petsView = view('pets');

const vehiclesDigest = defineDigest({
	id: 'vehicles.digest',
	topic: 'vehicles',
	title: 'Vehicles',
	description: 'What the vehicles need',
	requires: vehiclesView.id,
	run: (_uow, input) =>
		digestOf(
			[{ handle: null, kind: 'duty', title: 'Inspection', date: input.from, people: [] }],
			input,
		),
});
const petsDigest = defineDigest({
	id: 'pets.digest',
	topic: 'pets',
	title: 'Pets',
	description: 'What the pets need',
	requires: petsView.id,
	run: (_uow, input) => digestOf([], input),
});
const vehicles = defineTestExtension({
	id: 'vehicles',
	actions: [vehiclesDigest],
	capabilities: [vehiclesView],
});
const pets = defineTestExtension({ id: 'pets', actions: [petsDigest], capabilities: [petsView] });

const SPAN = { from: '2026-01-05', to: '2026-01-11' };

let k: TestKernel;
afterEach(async () => {
	await k?.close();
});

const aiFor = (m: { member: { id: string } }, roleId: string, local?: boolean): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: m.member.id as MemberId,
	roleId,
	...(local && { local: true }),
});

const read = async (actionId: string, actor: Actor, input: object = SPAN) => {
	const result = await k.runner.invoke<DigestOutput>(actionId, input, actor);
	if (result.status !== 'applied') throw new Error('expected a read');
	return result.output;
};

describe('digests in the registry', () => {
	it('refuses a digest for a topic another area keeps', () => {
		expect(() =>
			buildRegistry([
				defineTestExtension({
					id: 'garage',
					actions: [{ ...vehiclesDigest, id: 'garage.digest', requires: 'garage.view' }],
					capabilities: [view('garage')],
				}),
			]),
		).toThrow(/the "vehicles" area keeps/);
	});

	it('refuses two digests for one topic', () => {
		const second = { ...vehiclesDigest, id: 'vehicles.otherDigest' };
		expect(() =>
			buildRegistry([
				defineTestExtension({
					id: 'vehicles',
					actions: [vehiclesDigest, second],
					capabilities: [vehiclesView],
				}),
			]),
		).toThrow(/two digests/);
	});

	it('refuses a digest that does not take and give the digest shapes', () => {
		const own = defineAction({
			id: 'vehicles.digest',
			title: 'Own shapes',
			input: DigestInputSchema.and(DigestInputSchema),
			output: DigestOutputSchema,
			readOnly: true,
			ai: { description: 'x', digest: 'vehicles' },
			run: async () => ({ items: [], truncated: false }),
		});
		expect(() => buildRegistry([defineTestExtension({ id: 'vehicles', actions: [own] })])).toThrow(
			/use defineDigest/,
		);
	});
});

describe('ctx.actions.aiDigests', () => {
	it('lists each topic’s digest in topic order, and never as a read tool', async () => {
		k = await createTestKernel({ extensions: [vehicles, pets] });
		const admin = await k.member('admin');
		const digests = k.ctx.actions.aiDigests({ actor: aiFor(admin, 'admin') });
		expect(digests).toEqual([
			{ topic: 'pets', actionId: 'pets.digest', area: 'pets' },
			{ topic: 'vehicles', actionId: 'vehicles.digest', area: 'vehicles' },
			{ topic: 'suggestions', actionId: 'core.suggestionsDigest', area: 'core' },
		]);
		const tools = k.ctx.actions.aiReadTools({ actor: aiFor(admin, 'admin') }).map((t) => t.id);
		expect(tools).not.toContain('vehicles.digest');
		expect(tools).not.toContain('core.suggestionsDigest');
	});

	it('leaves out an area that is off, or local-only for a model that is not local', async () => {
		k = await createTestKernel({ extensions: [vehicles, pets] });
		const admin = await k.member('admin');
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'vehicles', access: 'off' },
			admin.actor,
		);
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'pets', access: 'local' },
			admin.actor,
		);
		const topics = (options: { local?: boolean; actor?: Actor }) =>
			k.ctx.actions.aiDigests(options).map((d) => d.topic);
		expect(topics({ actor: aiFor(admin, 'admin') })).toEqual(['suggestions']);
		expect(topics({ actor: aiFor(admin, 'admin', true), local: true })).toEqual([
			'pets',
			'suggestions',
		]);
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'pets', enabled: false },
			systemActor('test'),
		);
		expect(topics({ actor: aiFor(admin, 'admin', true), local: true })).toEqual(['suggestions']);
	});

	it('leaves out a digest the person asking may not read', async () => {
		k = await createTestKernel({ extensions: [vehicles] });
		const admin = await k.member('admin');
		const created = await k.runner.invoke<{ id: string }>(
			'core.createRole',
			{ name: 'No cars', base: 'member', overrides: { 'vehicles.view': false } },
			admin.actor,
		);
		if (created.status !== 'applied') throw new Error('expected the role');
		const role = created.output.id;
		const limited = await k.member(role);
		expect(k.ctx.actions.aiDigests({ actor: aiFor(limited, role) }).map((d) => d.topic)).toEqual([
			'suggestions',
		]);
		await expect(
			k.runner.invoke('vehicles.digest', SPAN, aiFor(limited, role)),
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('reading a digest as the AI', () => {
	it('gives nothing from an area that is off for the AI', async () => {
		k = await createTestKernel({ extensions: [vehicles] });
		const admin = await k.member('admin');
		expect((await read('vehicles.digest', aiFor(admin, 'admin'))).items).toHaveLength(1);
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'vehicles', access: 'off' },
			admin.actor,
		);
		await expect(
			k.runner.invoke('vehicles.digest', SPAN, aiFor(admin, 'admin')),
		).rejects.toMatchObject({ code: 'forbidden' });
		// A person still reads it.
		expect((await read('vehicles.digest', admin.actor)).items).toHaveLength(1);
	});

	it('gives a local-only area only to a local model', async () => {
		k = await createTestKernel({ extensions: [vehicles] });
		const admin = await k.member('admin');
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'vehicles', access: 'local' },
			admin.actor,
		);
		await expect(
			k.runner.invoke('vehicles.digest', SPAN, aiFor(admin, 'admin')),
		).rejects.toMatchObject({ code: 'forbidden' });
		expect((await read('vehicles.digest', aiFor(admin, 'admin', true))).items).toHaveLength(1);
	});

	it('refuses a span the digest cannot read', async () => {
		k = await createTestKernel({ extensions: [vehicles] });
		const admin = await k.member('admin');
		await expect(
			k.runner.invoke(
				'vehicles.digest',
				{ from: '2026-01-11', to: '2026-01-05' },
				aiFor(admin, 'admin'),
			),
		).rejects.toMatchObject({ code: 'bad_request' });
	});
});

describe('core.suggestionsDigest', () => {
	const QUICK_ADD: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };
	const propose = async (actor: Actor, body: string, summary?: string) => {
		const result = await k.runner.invoke('notes.addNote', { body }, actor, {
			draft: { sourceKind: 'inbox', sourceId: body, ...(summary && { summary }) },
		});
		if (result.status !== 'drafted') throw new Error('expected a draft');
		return result.draftId;
	};
	const titles = (out: DigestOutput) => out.items.map((i) => i.title);

	it('lists what waits for the asker to decide, wherever it was made, and their own', async () => {
		k = await createTestKernel({ extensions: [notesExtension] });
		const mara = await k.member('admin');
		const leo = await k.member('supervised');
		const card = await propose(QUICK_ADD, 'Parents evening', 'School letter');
		const request = await propose(leo.actor, 'Ice cream');
		const decided = await propose(QUICK_ADD, 'Old card');
		await k.runner.rejectDraft(decided, mara.actor);

		const forMara = await read('core.suggestionsDigest', aiFor(mara, 'admin'));
		expect(forMara.items.map((i) => i.handle)).toEqual([request, card]);
		const [first, second] = forMara.items;
		expect(first).toMatchObject({
			kind: 'suggestion',
			status: 'waiting',
			people: [leo.member.id],
			date: '2026-01-05',
			extra: { waitsFor: 'asker', suggestedOn: '2026-01-01' },
		});
		expect(first?.title).toContain('Ice cream');
		expect(second?.extra).toMatchObject({ waitsFor: 'asker', group: 'School letter' });
		expect(titles(forMara).join(' ')).not.toContain('Old card');

		// The child cannot decide either; their own request waits for someone else.
		const forLeo = await read('core.suggestionsDigest', aiFor(leo, 'supervised'));
		expect(forLeo.items.map((i) => i.handle)).toEqual([request]);
		expect(forLeo.items[0]?.extra?.waitsFor).toBe('others');
	});

	it('answers a caller with no member behind it with nothing, and every other kind as before', async () => {
		k = await createTestKernel({ extensions: [notesExtension] });
		const mara = await k.member('admin');
		await propose(QUICK_ADD, 'Parents evening');
		const nobody = await read('core.suggestionsDigest', QUICK_ADD);
		expect(nobody.items).toEqual([]);
		const system = await read('core.suggestionsDigest', systemActor('test'));
		expect(system.items).toEqual([]);
		// A person, and an AI working for the same person, both see the waiting card.
		expect((await read('core.suggestionsDigest', mara.actor)).items).toHaveLength(1);
		expect((await read('core.suggestionsDigest', aiFor(mara, 'admin'))).items).toHaveLength(1);
		// An app acting for a member is that member, with the role the member holds.
		const viaApp: Actor = {
			...mara.actor,
			via: { appId: 'app_one', appRoleId: 'member', mode: 'apply' },
		};
		expect((await read('core.suggestionsDigest', viaApp)).items).toHaveLength(1);
	});

	it('keeps every waiting suggestion whatever the span, people and words', async () => {
		k = await createTestKernel({ extensions: [notesExtension] });
		const mara = await k.member('admin');
		await propose(QUICK_ADD, 'Dentist');
		await propose(QUICK_ADD, 'Swimming kit');
		const out = await read('core.suggestionsDigest', aiFor(mara, 'admin'), {
			from: '2026-03-01',
			to: '2026-03-07',
			memberIds: [mara.member.id],
			about: ['swimming'],
		});
		expect(titles(out)).toHaveLength(2);
		expect(titles(out)[0]).toContain('Swimming kit');
		expect(out.items.every((i) => i.date === '2026-03-01')).toBe(true);
	});

	it('counts what the AI may not see as hidden, and shows it to the person', async () => {
		k = await createTestKernel({ extensions: [notesExtension] });
		const mara = await k.member('admin');
		await propose(QUICK_ADD, 'Diary entry');
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'notes', access: 'local' },
			mara.actor,
		);
		const remote = await read('core.suggestionsDigest', aiFor(mara, 'admin'));
		expect(remote).toEqual({ items: [], truncated: false, hidden: 1 });
		expect((await read('core.suggestionsDigest', aiFor(mara, 'admin', true))).items).toHaveLength(
			1,
		);
		expect((await read('core.suggestionsDigest', mara.actor)).items).toHaveLength(1);
	});

	it('cuts at fifteen, newest first', async () => {
		k = await createTestKernel({ extensions: [notesExtension] });
		const mara = await k.member('admin');
		for (let i = 0; i < 17; i++) {
			await propose(QUICK_ADD, `Card ${i}`);
			k.clock.advance(1000);
		}
		const out = await read('core.suggestionsDigest', aiFor(mara, 'admin'));
		expect(out.items).toHaveLength(15);
		expect(out.truncated).toBe(true);
		expect(out.items[0]?.title).toContain('Card 16');
	});

	it('is empty for an AI working for nobody', async () => {
		k = await createTestKernel({ extensions: [notesExtension] });
		await propose(QUICK_ADD, 'Card');
		expect(await read('core.suggestionsDigest', QUICK_ADD)).toEqual({
			items: [],
			truncated: false,
		});
	});
});
