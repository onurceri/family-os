import { randomUUID } from 'node:crypto';
import {
	AiContextSchema,
	defineAction,
	defineCapability,
	defineMentionKind,
	type MentionRefusal,
	type Resolution,
	systemActor,
} from '@famos/sdk';
import {
	createTestKernel,
	defineTestExtension,
	mention,
	type TestKernel,
	understood,
} from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import inbox from '../src/server/index.ts';

/**
 * How Quick add shares an area's records with the model, judged on a made-up area: what any
 * extension's `ai.context` gives is listed by name, an area that is locked, local-only or
 * switched off tells the model nothing, a long area is cut, and the kinds' resolvers find the
 * records the model names among those listed, so no id ever passes through the model.
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
/** A plant the `about` words name among the listed records, or the refusal why not. */
const plantOf = (
	ctx: Parameters<Parameters<typeof defineMentionKind>[0]['resolve']>[0],
	about: string | undefined,
	index: number,
) => {
	const found = ctx.record(about, ['plant']);
	if ('found' in found) return found.found;
	const reason = 'ambiguous' in found ? 'ambiguous' : 'unknown';
	return { refuse: { reason, subject: about ?? null, from: [index] } } as {
		refuse: MentionRefusal;
	};
};
const noteKind = defineMentionKind({
	id: 'garden.note',
	describe: 'Something to remember about a plant.',
	slots: { about: 'The plant', title: 'What to remember' },
	actions: ['garden.addNote'],
	knownFrom: [contextAction.id],
	examples: [
		{
			text: 'The olive tree must come inside before frost',
			mentions: [
				{
					kind: 'garden.note',
					quote: 'The olive tree must come inside before frost',
					about: 'Olive tree',
					title: 'Bring inside before frost',
				},
			],
		},
	],
	async resolve(ctx, mentions) {
		return mentions.map(({ index, mention: m }): Resolution => {
			const plant = plantOf(ctx, m.about, index);
			if ('refuse' in plant) return plant;
			return {
				propose: {
					actionId: 'garden.addNote',
					input: {
						recordId: plant.id,
						recordKind: plant.kind,
						recordName: plant.label,
						...(plant.url && { recordUrl: plant.url }),
						title: m.title ?? '',
					},
					subject: m.title ?? null,
					from: [index],
				},
			};
		});
	},
});
const wateredKind = defineMentionKind({
	id: 'garden.watered',
	describe: 'News that a plant was watered.',
	slots: { about: 'The plant' },
	actions: ['garden.water'],
	knownFrom: [contextAction.id],
	examples: [
		{
			text: 'Watered the fern',
			mentions: [{ kind: 'garden.watered', quote: 'Watered the fern', about: 'Fern' }],
		},
	],
	async resolve(ctx, mentions) {
		return mentions.map(({ index, mention: m }): Resolution => {
			const plant = plantOf(ctx, m.about, index);
			if ('refuse' in plant) return plant;
			return {
				propose: {
					actionId: 'garden.water',
					input: { plantId: plant.id, on: ctx.today },
					subject: m.about ?? null,
					from: [index],
				},
			};
		});
	},
});
const garden = defineTestExtension({
	id: 'garden',
	capabilities: [gardenView, gardenEdit],
	ai: { context: contextAction.id, kinds: [noteKind, wateredKind] },
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
	it('lists them by name with their details, and never an id or a handle', async () => {
		k.llm.respond(understood([], { label: 'x' }));
		await read();
		const system = k.llm.calls[0]?.system ?? '';
		expect(system).toContain('## Known names');
		expect(system).toContain('Plants:\n- Fern (north window)\n- Olive tree (balcony)');
		expect(system).toMatch(/### garden\.note\n[\s\S]*Known names: Plants/);
		const seen = JSON.stringify(
			k.llm.calls.map(({ system, prompt, jsonSchema }) => ({ system, prompt, jsonSchema })),
		);
		expect(seen).not.toMatch(/plant_[0-9a-f]{8}|plant:\d/);
		expect(k.llm.calls[0]?.areas).toEqual(expect.arrayContaining(['inbox', 'garden']));
	});

	it('leaves a locked area out: no records, no kinds, no area, until it is opened again', async () => {
		await setArea('off');
		await read();
		// Nothing is left to read, so the model is not asked at all.
		expect(k.llm.calls).toHaveLength(0);
		expect(await lastItem()).toMatchObject({ proposals: 0 });

		await setArea('any');
		k.llm.respond(understood([], { label: 'x' }));
		await read('Again');
		expect(k.llm.calls[0]?.system).toContain('- Fern (north window)');
		expect(k.llm.calls[0]?.system).toContain('### garden.note');
	});

	it('leaves out a local-only area for a remote model, and shows it for a local one', async () => {
		await setArea('local');
		await read();
		expect(k.llm.calls).toHaveLength(0);
		k.llm.privacy.local = true;
		k.llm.respond(understood([mention('garden.watered', { about: 'fern' })]));
		await read('Watered the fern again');
		expect(k.llm.calls[0]?.system).toContain('- Fern (north window)');
		// The local model's mentions are resolved too.
		expect((await drafts()).map((d) => d.actionId)).toEqual(['garden.water']);
	});

	it('shares nothing when the area is off for people too (feature switched off)', async () => {
		await k.runner.invoke(
			'core.setFeatureEnabled',
			{ extensionId: 'garden', enabled: false },
			admin.actor,
		);
		k.llm.respond(understood([], { label: 'x' }));
		await read();
		expect(JSON.stringify(k.llm.calls)).not.toContain('Fern');
	});

	it('gives at most 50 items per area', async () => {
		for (let i = 0; i < 52; i++) plant(`Pot ${i + 1}`);
		k.llm.respond(understood([], { label: 'x' }));
		await read('A note');
		const system = k.llm.calls[0]?.system ?? '';
		// Fern and Olive tree plus 48 of the 52 more.
		expect(system).toMatch(/- Pot 48(\n|$)/);
		expect(system).not.toContain('- Pot 49\n');
	});

	it('puts the items the text names first when an area is longer than fits', async () => {
		for (let i = 0; i < 60; i++) plant(`Pot ${i + 1}`);
		plant('Lemon tree');
		k.llm.respond(understood([], { label: 'x' }));
		await read('The lemon tree needs repotting.');
		expect(k.llm.calls[0]?.system).toContain('Plants:\n- Lemon tree');
	});
});

describe('mentions that name a record', () => {
	it('finds the record among those listed and fills its id, kind, name and page', async () => {
		k.llm.respond(
			understood([
				mention('garden.note', { about: 'the olive tree', title: 'Bring inside before frost' }),
			]),
		);
		await read('The olive tree must come inside before frost');
		const [draft] = await drafts();
		expect(draft?.input).toMatchObject({
			recordId: olive,
			recordKind: 'plant',
			recordName: 'Olive tree',
			recordUrl: `/garden/${olive}`,
			title: 'Bring inside before frost',
		});
	});

	it('refuses a record that is not listed, or one that is no longer there', async () => {
		k.llm.respond(
			understood([
				mention('garden.watered', { about: 'cactus' }),
				mention('garden.watered', { about: 'fern' }),
			]),
		);
		await read('Watered the cactus and the fern');
		expect((await drafts()).map((d) => d.input)).toEqual([{ plantId: fern, on: '2026-10-06' }]);
		expect(await lastItem()).toMatchObject({ status: 'extracted', proposals: 1, skipped: 1 });
	});

	it('skips a suggestion the action refuses, and still reads the item', async () => {
		k.llm.respond(
			understood([
				// No title: the action refuses the input.
				mention('garden.note', { about: 'fern' }),
				mention('garden.watered', { about: 'fern' }),
			]),
		);
		await read();
		expect((await drafts()).map((d) => d.actionId)).toEqual(['garden.water']);
		expect(await lastItem()).toMatchObject({ status: 'extracted', proposals: 1, skipped: 1 });
	});
});
