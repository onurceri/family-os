import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import records from '@famos/ext-records/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/contract/index.ts';
import inbox from '../src/server/index.ts';
import { rankByMention, tidyLeftOut, unnamedMemberFields } from '../src/server/process.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar, lists, records, inbox] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
	admin = await k.member('admin', 'Noah');
});
afterEach(() => k.close());

const read = async (text: string) => {
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
const item = async () =>
	(await k.route('inbox.listItems').call({ query: { limit: 5 }, actor: admin.actor })) as [
		InboxItem,
	];
const system = () => k.llm.calls[0]?.system ?? '';

describe('rankByMention', () => {
	const labels = ['Bread', 'Pasta', 'Avocado', 'Oat milk'].map((label) => ({ label }));

	it('puts what the text names first, best match first, and keeps the rest in order', () => {
		expect(rankByMention(labels, 'Bought oat milk and an avocado').map((i) => i.label)).toEqual([
			'Avocado',
			'Oat milk',
			'Bread',
			'Pasta',
		]);
	});

	it('keeps the order when the text names nothing or is empty', () => {
		const order = labels.map((i) => i.label);
		expect(rankByMention(labels, 'Hello there').map((i) => i.label)).toEqual(order);
		expect(rankByMention(labels, '  ').map((i) => i.label)).toEqual(order);
	});
});

describe('what the model is shown of long lists', () => {
	it('includes an old item the text names although many newer ones are open', async () => {
		// Real case: Avocado was the 52nd newest of 78 open items and never reached the model.
		const add = (titles: string[]) =>
			k.runner.invoke(
				'lists.addShoppingItems',
				{ items: titles.map((title) => ({ title })) },
				admin.actor,
			);
		await add(['Avocado']);
		await add(Array.from({ length: 39 }, (_, i) => `Pantry staple ${i + 1}`));
		await add(Array.from({ length: 38 }, (_, i) => `Fridge staple ${i + 1}`));
		k.llm.respond({
			summary: 'Avocado bought',
			proposals: [
				{
					action: 'lists.checkShoppingItem',
					input: { id: 'shop_item:1', done: true, label: 'Avocado' },
					confidence: 0.9,
				},
			],
		});
		await read('Bought the avocado, tick it off');
		expect(system()).toContain('- Avocado (shop_item:1)');
		const [draft] = await drafts();
		expect(draft).toMatchObject({ actionId: 'lists.checkShoppingItem', input: { done: true } });
		expect(await item()).toMatchObject([{ proposals: 1, skipped: 0 }]);
	});

	it('does the same for tasks', async () => {
		await k.runner.invoke('lists.addTask', { title: 'Renew the library card' }, admin.actor);
		for (let i = 0; i < 60; i++)
			await k.runner.invoke('lists.addTask', { title: `Chore number ${i + 1}` }, admin.actor);
		k.llm.respond({ summary: 'x', proposals: [] });
		await read('I renewed the library card');
		expect(system()).toContain('- Renew the library card (task:1)');
	});
});

describe('what the model leaves out', () => {
	it('keeps and shows why "bought oat milk" got no proposal', async () => {
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Bread' }] }, admin.actor);
		// Real model output: nothing proposed, and no word about why.
		k.llm.respond({
			summary: 'Oat milk bought',
			kind: 'nothing',
			proposals: [],
			leftOut: [{ text: 'Oat milk', reason: 'not_listed' }],
		});
		await read('Bought oat milk');
		expect(await item()).toMatchObject([
			{ proposals: 0, leftOut: [{ text: 'Oat milk', reason: 'not_listed' }] },
		]);
	});

	it('keeps the vet appointment when the pet is not listed, and says the pet is unknown', async () => {
		// Real model output before the prompt was narrowed: the whole item was dropped. Now the
		// appointment is proposed and only the pet is reported.
		await k.runner.invoke(
			'records.addObligation',
			{
				title: 'Car insurance',
				recordId: 'vehicle_00000000-0000-7000-8000-000000000001',
				recordKind: 'vehicle',
				recordName: 'Golf',
				dueDate: '2026-10-20',
			},
			admin.actor,
		);
		k.llm.respond({
			summary: 'Vet check',
			proposals: [
				{
					action: 'calendar.createEvent',
					input: {
						title: "Miso's annual check",
						date: '2026-10-15',
						startTime: '10:30',
						location: 'Riverside Vet Clinic',
					},
					dateText: 'Thu 15',
					confidence: 0.8,
				},
			],
			leftOut: [{ text: 'Miso', reason: 'unknown_record' }],
		});
		await read("Miso's annual check Thu 15 10:30, Riverside Vet Clinic");
		expect(system()).toContain('A record that is not listed only drops the proposal that needs it');
		const [draft] = await drafts();
		expect(draft).toMatchObject({
			actionId: 'calendar.createEvent',
			input: { location: 'Riverside Vet Clinic', startTime: '10:30' },
		});
		expect(await item()).toMatchObject([
			{ proposals: 1, leftOut: [{ text: 'Miso', reason: 'unknown_record' }] },
		]);
	});

	it('drops malformed entries instead of failing the reading', async () => {
		k.llm.respond({
			summary: 'x',
			proposals: [],
			leftOut: [
				{ text: 'Oat milk', reason: 'not_listed' },
				{ text: 'Oat milk', reason: 'not_listed' },
				{ text: 'Soap', reason: 'because I said so' },
				'Eggs',
				{ text: '', reason: 'unclear' },
			],
		});
		await read('Bought oat milk, soap and eggs');
		expect(await item()).toMatchObject([
			{ status: 'extracted', leftOut: [{ text: 'Oat milk', reason: 'not_listed' }] },
		]);
	});

	it('tidies a list to well-formed, distinct entries', () => {
		expect(
			tidyLeftOut([
				{ text: ' Miso ', reason: 'unknown_record' },
				{ text: 'miso', reason: 'unknown_record' },
				null,
				{ reason: 'unclear' },
			]),
		).toEqual([{ text: 'Miso', reason: 'unknown_record' }]);
	});

	it('has no left-out things on a plain reading', async () => {
		k.llm.respond({ summary: 'x', proposals: [] });
		await read('Hello');
		expect(await item()).toMatchObject([{ leftOut: [] }]);
	});
});

describe('moving an event that is already on the calendar', () => {
	beforeEach(async () => {
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Regional Gala', date: '2026-11-07', startTime: '18:00', endTime: '22:00' },
			admin.actor,
		);
		for (let i = 0; i < 3; i++)
			await k.runner.invoke(
				'calendar.createEvent',
				{ title: `Class trip ${i + 1}`, date: '2026-10-20', allDay: true },
				admin.actor,
			);
	});

	it('lists upcoming events with their day and time, without ids', async () => {
		k.llm.respond({ summary: 'x', proposals: [] });
		await read('Hello');
		expect(system()).toContain('Upcoming calendar events:');
		expect(system()).toContain('- Regional Gala (cal_event:');
		expect(system()).toMatch(/Regional Gala \(cal_event:\d+\): 2026-11-07, 18:00-22:00/);
		expect(JSON.stringify(k.llm.calls)).not.toMatch(/cal_event_[0-9a-f]{8}/);
	});

	it('changes the listed event when the item says it moved', async () => {
		k.llm.respond({
			summary: 'Gala moved',
			proposals: [
				{
					action: 'calendar.changeEvent',
					input: {
						id: 'cal_event:1',
						date: '2026-11-14',
						startTime: '09:00',
						label: 'Regional gala',
					},
					dateText: 'Sat 14 Nov',
					confidence: 0.9,
				},
			],
		});
		await read('Regional gala moved to Sat 14 Nov 09:00');
		expect(system()).toContain('calendar.changeEvent');
		expect(system()).toContain('says an event moved or changed');
		const [draft] = await drafts();
		expect(draft).toMatchObject({
			actionId: 'calendar.changeEvent',
			input: { date: '2026-11-14', startTime: '09:00' },
		});
		expect(await item()).toMatchObject([{ proposals: 1, skipped: 0 }]);
	});

	it('marks a new event for the same title a week later as already there', async () => {
		// Real model output: it never saw the event, so the move became a second one.
		k.llm.respond({
			summary: 'Regional Gala',
			proposals: [
				{
					action: 'calendar.createEvent',
					input: { title: 'Regional Gala', date: '2026-11-14', startTime: '09:00' },
					dateText: 'Sat 14 Nov',
					confidence: 0.8,
				},
			],
		});
		await read('Regional gala moved to Sat 14 Nov 09:00');
		const listed = (await k.route('core.listDrafts').call({
			query: { status: 'pending', limit: 10 },
			actor: admin.actor,
		})) as { actionId: string; mayExist: boolean }[];
		expect(listed.find((d) => d.actionId === 'calendar.createEvent')?.mayExist).toBe(true);
	});
});

describe('the person who shared the item', () => {
	const members = [
		{ id: 'member_noah', displayName: 'Noah' },
		{ id: 'member_ellie', displayName: 'Ellie' },
	];

	it('is not marked "check this" on an item that says "me"', () => {
		const input = { memberIds: ['member_noah'] };
		expect(unnamedMemberFields(input, members, 'dentist for me on Thu', 'en')).toEqual([
			'memberIds',
		]);
		expect(
			unnamedMemberFields(input, members, 'dentist for me on Thu', 'en', 'member_noah'),
		).toEqual([]);
	});

	it('still marks someone else the item never names', () => {
		expect(
			unnamedMemberFields(
				{ memberIds: ['member_ellie'] },
				members,
				'dentist for me on Thu',
				'en',
				'member_noah',
			),
		).toEqual(['memberIds']);
		expect(
			unnamedMemberFields(
				{ memberIds: ['member_noah', 'member_ellie'] },
				members,
				'dentist for me on Thu',
				'en',
				'member_noah',
			),
		).toEqual(['memberIds']);
	});
});
