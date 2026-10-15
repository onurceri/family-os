import { randomUUID } from 'node:crypto';
import { AiContextSchema, defineAction, defineCapability, systemActor } from '@famos/sdk';
import { createTestKernel, defineTestExtension, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import inbox from '../src/server/index.ts';

/**
 * How Quick add shares an area's records with the model, judged on a made-up area: what any
 * extension's `ai.context` gives is listed by handle, an area that is locked, local-only or
 * switched off tells the model nothing, a long area is cut, and handles in proposals are mapped
 * back to ids (the record's kind, name and page filled in) while invented ones are dropped.
 */
const TZ = 'Europe/Istanbul';
let plants: { id: string; label: string; details?: string; url?: string }[] = [];
const plant = (label: string, details?: string) => {
	const id = `plant_${randomUUID()}`;
	plants.push({ id, label, ...(details && { details }), url: `/garden/${id}` });
	return id;
};

const gardenView = defineCapability({ id: 'garden.view', label: 'garden:view', level: 'view' });
const gardenEdit = defineCapability({ id: 'garden.edit', label: 'garden:edit', level: 'edit' });
const contextAction = defineAction({
	id: 'garden.aiContext',
	title: 'Plants, for the AI',
	input: z.object({}),
	output: AiContextSchema,
	readOnly: true,
	requires: gardenView.id,
	ai: { description: 'Lists the plants.' },
	async run() {
		return { kind: 'plant', label: 'Plants', items: plants };
	},
});
const garden = defineTestExtension({
	id: 'garden',
	capabilities: [gardenView, gardenEdit],
	ai: { context: contextAction.id },
	actions: [
		contextAction,
		defineAction({
			id: 'garden.addNote',
			title: 'Add a note to a plant',
			input: z.object({
				recordId: z.string(),
				recordKind: z.string(),
				recordName: z.string(),
				recordUrl: z.string().optional(),
				title: z.string().min(1),
			}),
			output: z.object({}),
			approval: { unless: gardenEdit.id },
			ai: { description: 'Adds a note to a plant.' },
			async run() {
				return {};
			},
		}),
		defineAction({
			id: 'garden.water',
			title: 'Water a plant',
			input: z.object({ plantId: z.string(), on: z.string() }),
			output: z.object({}),
			approval: { unless: gardenEdit.id },
			ai: { description: 'Records that a plant was watered.' },
			async run() {
				return {};
			},
		}),
	],
});

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let fern: string;
let olive: string;

beforeEach(async () => {
	plants = [];
	k = await createTestKernel({ extensions: [garden, inbox] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
	admin = await k.member('admin', 'Ayşe');
	fern = plant('Fern', 'north window');
	olive = plant('Olive tree', 'balcony');
});
afterEach(() => k.close());

const read = async (text = 'Watered the fern today.') => {
	await k.route('inbox.createItem').call({
		body: { channel: 'share', text },
		files: [],
		actor: admin.actor,
	});
	await k.worker.drain();
};
const drafts = (): Promise<{ id: string; actionId: string; input: Record<string, unknown> }[]> =>
	k.route('core.listDrafts').call({
		query: { sourceKind: 'inbox', limit: 50 },
		actor: admin.actor,
	});
const lastItem = async () =>
	(
		(await k.route('inbox.listItems').call({
			query: { limit: 5 },
			actor: admin.actor,
		})) as { status: string; proposals: number; skipped: number }[]
	)[0];
const setArea = (access: 'off' | 'local' | 'any') =>
	k.runner.invoke('core.setAiAreaAccess', { extensionId: 'garden', access }, admin.actor);

describe('an area’s records in the prompt', () => {
	it('lists them by handle with their details, and never an id', async () => {
		k.llm.respond({ summary: 'x', proposals: [] });
		await read();
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).toContain('Household records');
		expect(system).toContain('Plants:');
		expect(system).toContain('- Fern (plant:1): north window');
		expect(system).toContain('- Olive tree (plant:2): balcony');
		const seen = JSON.stringify(
			k.llm.calls.map(({ system, prompt, jsonSchema }) => ({ system, prompt, jsonSchema })),
		);
		expect(seen).not.toMatch(/plant_[0-9a-f]{8}/);
		expect(k.llm.calls[0]?.areas).toEqual(expect.arrayContaining(['inbox', 'garden']));
	});

	it('leaves a locked area out: no records, no actions, no area, until it is opened again', async () => {
		await setArea('off');
		k.llm.respond({ summary: 'x', proposals: [] });
		await read();
		// Nothing is left to propose, so the model is not asked at all.
		expect(k.llm.calls).toHaveLength(0);
		expect(await lastItem()).toMatchObject({ proposals: 0 });

		await setArea('any');
		k.llm.respond({ summary: 'x', proposals: [] });
		await read('Again');
		expect(k.llm.calls[0]?.system).toContain('Fern (plant:1)');
		expect(k.llm.calls[0]?.system).toContain('garden.addNote');
	});

	it('leaves out a local-only area for a remote model, and shows it for a local one', async () => {
		await setArea('local');
		k.llm.respond({ summary: 'x', proposals: [] });
		await read();
		expect(k.llm.calls).toHaveLength(0);
		k.llm.privacy.local = true;
		k.llm.respond({ summary: 'x', proposals: [] });
		await read('One more note');
		expect(k.llm.calls[0]?.system).toContain('Fern (plant:1)');
	});

	it('shares nothing when the area is off for people too (feature switched off)', async () => {
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'garden', enabled: false },
			admin.actor,
		);
		k.llm.respond({ summary: 'x', proposals: [] });
		await read();
		expect(JSON.stringify(k.llm.calls)).not.toContain('(plant:');
	});

	it('gives at most 50 items per area', async () => {
		for (let i = 0; i < 52; i++) plant(`Pot ${i + 1}`);
		k.llm.respond({ summary: 'x', proposals: [] });
		await read('A note');
		const system = k.llm.calls[0]?.system ?? '';
		// Fern and Olive tree plus 48 of the 52 more.
		expect(system).toContain('(plant:50)');
		expect(system).not.toContain('(plant:51)');
	});

	it('puts the items the text names first when an area is longer than fits', async () => {
		for (let i = 0; i < 60; i++) plant(`Pot ${i + 1}`);
		plant('Lemon tree');
		k.llm.respond({ summary: 'x', proposals: [] });
		await read('The lemon tree needs repotting.');
		expect(k.llm.calls[0]?.system).toContain('Lemon tree (plant:');
	});
});

describe('proposals that name a record', () => {
	it('maps a handle to its id and fills the record’s kind, name and page', async () => {
		k.llm.respond({
			summary: 'Note',
			proposals: [
				{
					action: 'garden.addNote',
					input: {
						recordId: 'plant:2',
						recordKind: 'tree', // wrong on purpose: the area knows better
						recordName: 'Whatever',
						title: 'Bring inside before frost',
					},
					confidence: 0.8,
				},
			],
		});
		await read();
		const [draft] = await drafts();
		expect(draft?.input).toMatchObject({
			recordId: olive,
			recordKind: 'plant',
			recordName: 'Olive tree',
			recordUrl: `/garden/${olive}`,
			title: 'Bring inside before frost',
		});
	});

	it('maps a handle in any other field too', async () => {
		k.llm.respond({
			summary: 'Watered',
			proposals: [
				{
					action: 'garden.water',
					input: { plantId: 'plant:1', on: '2026-10-06' },
					confidence: 0.9,
				},
			],
		});
		await read();
		const [draft] = await drafts();
		expect(draft?.input).toMatchObject({ plantId: fern, on: '2026-10-06' });
	});

	it('drops proposals for records it never listed', async () => {
		const invented = `plant_${randomUUID()}`;
		const note = { recordKind: 'plant', recordName: 'X', title: 'A' };
		k.llm.respond({
			summary: 'x',
			proposals: [
				{ action: 'garden.addNote', input: { ...note, recordId: 'plant:9' }, confidence: 1 },
				{ action: 'garden.addNote', input: { ...note, recordId: invented }, confidence: 1 },
				{
					action: 'garden.water',
					input: { plantId: invented, on: '2026-10-01' },
					confidence: 1,
				},
			],
		});
		await read();
		expect(await drafts()).toHaveLength(0);
		expect(await lastItem()).toMatchObject({ status: 'extracted', proposals: 0, skipped: 3 });
	});

	it('skips a proposal the action refuses, and still reads the item', async () => {
		k.llm.respond({
			summary: 'Note',
			proposals: [
				{ action: 'garden.addNote', input: { recordId: 'plant:1', title: '' }, confidence: 0.8 },
				{
					action: 'garden.water',
					input: { plantId: 'plant:1', on: '2026-10-06' },
					confidence: 0.9,
				},
			],
		});
		await read();
		expect((await drafts()).map((d) => d.actionId)).toEqual(['garden.water']);
		expect(await lastItem()).toMatchObject({ status: 'extracted', proposals: 1, skipped: 1 });
	});
});
