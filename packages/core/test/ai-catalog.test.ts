import { defineAction, defineCapability } from '@famos/sdk';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const thingsEdit = defineCapability({ id: 'things.edit', label: 'things:cap_edit', level: 'edit' });
const addThing = defineAction({
	id: 'things.addThing',
	title: 'Add a thing',
	input: z.object({ name: z.string().min(1).describe('What to add'), when: z.string().optional() }),
	output: z.object({ ok: z.boolean() }),
	approval: { unless: thingsEdit.id },
	ai: { description: 'Adds a thing to the family list.', guidance: 'Use the shortest name.' },
	async run() {
		return { ok: true };
	},
});
const notForAi = defineAction({
	id: 'things.purge',
	title: 'Purge',
	input: z.object({}),
	output: z.object({}),
	requires: thingsEdit.id,
	async run() {
		return {};
	},
});

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({
		extensions: [
			defineTestExtension({
				id: 'things',
				actions: [addThing, notForAi],
				capabilities: [thingsEdit],
			}),
		],
	});
});
afterEach(() => k.close());

it('lists only AI-proposable actions, with JSON Schema inputs', () => {
	const catalog = k.ctx.actions.aiCatalog();
	expect(catalog.map((a) => a.id)).toEqual(['things.addThing']);
	expect(catalog[0]).toMatchObject({
		description: 'Adds a thing to the family list.',
		guidance: 'Use the shortest name.',
		inputSchema: {
			type: 'object',
			required: ['name'],
			properties: { name: { type: 'string', description: 'What to add' } },
		},
	});
});

it('stores uncertain fields on drafts', async () => {
	const result = await k.ctx.actions.invoke(
		'things.addThing',
		{ name: 'x' },
		{ kind: 'ai', mode: 'share', source: 'inbox' },
		{
			draft: { uncertainFields: ['when'], confidence: 0.6 },
		},
	);
	if (result.status !== 'drafted') throw new Error('expected a draft');
	const drafts = await k.route('core.listDrafts').call({ query: { limit: 10 } });
	expect(drafts[0]).toMatchObject({
		id: result.draftId,
		uncertainFields: ['when'],
		confidence: 0.6,
	});
	const row = await k.ctx.db
		.withTables<CoreTables>()
		.selectFrom('core_drafts')
		.select('uncertain_fields')
		.executeTakeFirst();
	expect(row?.uncertain_fields).toBe('["when"]');
});

it('offers conversation-only actions to the AI in the app conversation, not to agents or shares', async () => {
	const draftOnly = defineAction({
		id: 'things.makeRule',
		title: 'Make a rule',
		input: z.object({}),
		output: z.object({}),
		requires: thingsEdit.id,
		ai: { description: 'Makes a rule.', conversationOnly: true },
		async run() {
			return {};
		},
	});
	const kernel = await createTestKernel({
		extensions: [
			defineTestExtension({
				id: 'things',
				actions: [addThing, draftOnly],
				capabilities: [thingsEdit],
			}),
		],
	});
	try {
		const member = { onBehalfOf: 'member_x' as never, roleId: 'admin' };
		const ids = (actor: Parameters<typeof kernel.ctx.actions.aiCatalog>[0]) =>
			kernel.ctx.actions.aiCatalog(actor).map((a) => a.id);
		expect(
			ids({ actor: { kind: 'ai', mode: 'conversation', source: 'assistant', ...member } }),
		).toContain('things.makeRule');
		expect(ids({ actor: { kind: 'ai', mode: 'agent', source: 'mcp', ...member } })).toEqual([
			'things.addThing',
		]);
		expect(ids({ actor: { kind: 'ai', mode: 'share', source: 'inbox' } })).toEqual([
			'things.addThing',
		]);
		// The mode decides, never the name of the source.
		expect(ids({ actor: { kind: 'ai', mode: 'agent', source: 'assistant', ...member } })).toEqual([
			'things.addThing',
		]);
	} finally {
		await kernel.close();
	}
});
