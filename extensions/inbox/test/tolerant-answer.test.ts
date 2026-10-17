import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/contract/index.ts';
import inbox from '../src/server/index.ts';
import { readAnswer } from '../src/server/process.ts';

const TZ = 'Europe/Ljubljana';
let k: TestKernel;
let mara: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar, lists, inbox] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
	mara = await k.member('admin', 'Mara Novak');
});
afterEach(() => k.close());

const read = async (text: string) => {
	await k.route('inbox.createItem').call({
		body: { channel: 'text', text },
		files: [],
		actor: mara.actor,
	});
	await k.worker.drain();
	return (
		(await k
			.route('inbox.listItems')
			.call({ query: { limit: 1 }, actor: mara.actor })) as InboxItem[]
	)[0] as InboxItem;
};
const drafts = (): Promise<{ actionId: string; input: Record<string, unknown> }[]> =>
	k.route('core.listDrafts').call({ query: { sourceKind: 'inbox', limit: 50 }, actor: mara.actor });

describe("a model's careless answer", () => {
	it('keeps a proposal without a confidence, with dateText beside the proposals', async () => {
		// What gpt-4.1-mini answered, word for word, for a shopping message: the proposal has no
		// `confidence`, and an empty `dateText` sits beside the proposals.
		k.llm.respond(
			JSON.parse(
				'{"summary":"Shopping list items to buy","kind":"actionable","proposals":[{"action":"lists.addShoppingItems","input":{"items":[{"title":"Milk","quantity":"2 litres","category":"dairy"},{"title":"Minced beef","quantity":"half a kilo","category":"meat"},{"title":"Eggs","quantity":"6","category":"dairy"},{"title":"Nutella","quantity":"a jar","category":"pantry"}],"whenOnList":"keep"}}],"dateText":""}',
			),
		);
		const item = await read(
			'we need 2 litres of milk, half a kilo of minced beef, 6 eggs, a jar of nutella',
		);
		expect(item).toMatchObject({ status: 'extracted', proposals: 1, skipped: 0 });
		const [draft] = await drafts();
		expect(draft?.input).toMatchObject({
			items: [
				{ title: 'Milk', quantity: '2 litres' },
				{ title: 'Minced beef' },
				{ title: 'Eggs' },
				{ title: 'Nutella' },
			],
		});
	});

	it('keeps a proposal whose confidence and doubts were written beside it', async () => {
		// gpt-4.1-mini again, word for word, for a Turkish shopping list: `confidence` and
		// `uncertainFields` sit at the top level instead of in the one proposal.
		k.llm.respond(
			JSON.parse(
				'{"summary":"Alışveriş listesi: domates, makarna, peynir, deterjan","kind":"actionable","proposals":[{"action":"lists.addShoppingItems","input":{"items":[{"title":"Domates","quantity":"1 kg","category":"produce"},{"title":"Makarna","quantity":"2 paket","category":"pantry"},{"title":"Beyaz Peynir"},{"title":"Çamaşır Deterjanı","category":"household"}],"whenOnList":"keep"}}],"confidence":1,"uncertainFields":[]}',
			),
		);
		const item = await read('1 kg domates, 2 paket makarna, beyaz peynir, çamaşır deterjanı');
		expect(item).toMatchObject({ status: 'extracted', proposals: 1 });
		expect(await drafts()).toHaveLength(1);
	});

	it('drafts the good proposals when one cannot be read, and says what was left out', async () => {
		k.llm.respond({
			summary: 'Groceries and the dentist',
			kind: 'actionable',
			proposals: [
				// No action: nothing to draft, but the person hears about the dentist.
				{ input: { title: 'Dentist' }, confidence: 0.9 },
				{
					action: 'lists.addShoppingItems',
					input: { items: [{ title: 'Bread' }] },
					confidence: 'high',
					uncertainFields: 'none',
				},
			],
		});
		const item = await read('bread, and book the dentist');
		expect(item).toMatchObject({
			status: 'extracted',
			proposals: 1,
			skipped: 1,
			skips: [{ reason: 'incomplete', subject: 'Dentist' }],
		});
		expect((await drafts()).map((d) => d.actionId)).toEqual(['lists.addShoppingItems']);
	});

	it('reads an answer without a label or a kind', async () => {
		k.llm.respond({
			proposals: [{ action: 'lists.addShoppingItems', input: { items: [{ title: 'Bread' }] } }],
		});
		expect(await read('bread')).toMatchObject({
			status: 'extracted',
			kind: 'actionable',
			proposals: 1,
		});
	});
});

describe('reading the proposals one by one', () => {
	const base = { summary: 'x', kind: 'actionable' as const };

	it('moves proposal fields written inside the input out of it', () => {
		const { proposals } = readAnswer({
			...base,
			proposals: [
				{
					action: 'calendar.createEvent',
					input: { title: 'Zoo', startDate: '2026-10-16', dateText: 'Friday', confidence: 0.7 },
				},
			],
		});
		expect(proposals).toEqual([
			{
				action: 'calendar.createEvent',
				input: { title: 'Zoo', startDate: '2026-10-16' },
				confidence: 0.7,
				uncertainFields: [],
				dateText: 'Friday',
			},
		]);
	});

	it('reads an input written as a JSON string', () => {
		const { proposals } = readAnswer({
			...base,
			proposals: [{ action: 'lists.addTask', input: '{"title":"Call the plumber"}' }],
		});
		expect(proposals[0]?.input).toEqual({ title: 'Call the plumber' });
	});

	it('gives a stray dateText to the one proposal with a date and no words for it', () => {
		const { proposals } = readAnswer({
			...base,
			dateText: 'next Friday',
			proposals: [
				{ action: 'lists.addShoppingItems', input: { items: [{ title: 'Bread' }] } },
				{ action: 'calendar.createEvent', input: { title: 'Zoo', startDate: '2026-10-16' } },
			],
		});
		expect(proposals.map((p) => p.dateText)).toEqual([undefined, 'next Friday']);
	});

	it('keeps twelve proposals and reports the rest', () => {
		const many = Array.from({ length: 14 }, (_, i) => ({
			action: 'lists.addTask',
			input: { title: `Task ${i + 1}` },
		}));
		const { proposals, unreadable } = readAnswer({ ...base, proposals: many });
		expect(proposals).toHaveLength(12);
		expect(unreadable).toEqual([{ subject: 'Task 13' }, { subject: 'Task 14' }]);
	});
});
