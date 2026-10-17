import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import records from '@famos/ext-records/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, mention, type TestKernel, understood } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/contract/index.ts';
import inbox from '../src/server/index.ts';
import { rankByMention } from '../src/server/process.ts';

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
const drafts = (): Promise<
	{ id: string; actionId: string; input: Record<string, unknown>; uncertainFields: string[] }[]
> =>
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
		k.llm.respond(understood([mention('lists.bought', { target: 'avocado' })]));
		await read('Bought the avocado, tick it off');
		expect(system()).toMatch(/\n- Avocado( \(|\n)/);
		expect(system()).not.toContain('shop_item');
		const [draft] = await drafts();
		expect(draft).toMatchObject({ actionId: 'lists.checkShoppingItem', input: { done: true } });
		expect(await item()).toMatchObject([{ proposals: 1, skipped: 0 }]);
	});

	it('does the same for tasks', async () => {
		await k.runner.invoke('lists.addTask', { title: 'Renew the library card' }, admin.actor);
		for (let i = 0; i < 60; i++)
			await k.runner.invoke('lists.addTask', { title: `Chore number ${i + 1}` }, admin.actor);
		k.llm.respond(understood([], { label: 'x' }));
		await read('I renewed the library card');
		expect(system()).toMatch(/\n- Renew the library card( \(|\n)/);
	});
});

describe('an unlisted record', () => {
	it('keeps the vet appointment when the pet is not listed', async () => {
		// Real model output before the prompt was narrowed: the whole item was dropped. Now the
		// appointment is proposed.
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
		k.llm.respond(
			understood([
				mention('calendar.event', {
					title: "Miso's annual check",
					date: { text: 'Thu 15', day: 15, weekday: 4 },
					time: '10:30',
					timeText: '10:30',
					place: 'Riverside Vet Clinic',
				}),
			]),
		);
		await read("Miso's annual check Thu 15 10:30, Riverside Vet Clinic");
		const [draft] = await drafts();
		expect(draft).toMatchObject({
			actionId: 'calendar.createEvent',
			input: { location: 'Riverside Vet Clinic', startTime: '10:30' },
		});
		expect(await item()).toMatchObject([{ proposals: 1 }]);
	});
});

describe('an event that moved', () => {
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

	it('marks a new event for the same title a week later as already there', async () => {
		// Real model output: it never saw the event, so the move became a second one.
		k.llm.respond(
			understood([
				mention('calendar.event', {
					title: 'Regional gala',
					date: { text: 'Sat 14 Nov', day: 14, month: 11, weekday: 6 },
					time: '09:00',
					timeText: '09:00',
				}),
			]),
		);
		await read('Regional gala moved to Sat 14 Nov 09:00');
		const listed = (await k.route('core.listDrafts').call({
			query: { status: 'pending', limit: 10 },
			actor: admin.actor,
		})) as { actionId: string; mayExist: boolean }[];
		expect(listed.find((d) => d.actionId === 'calendar.createEvent')?.mayExist).toBe(true);
	});

	it('marks the real output, a new "Regional gala" a week later, as already there', async () => {
		// The model's answer to the swim coach's message, written in the message's own case.
		k.llm.respond(
			understood([
				mention('calendar.event', {
					title: 'Regional gala',
					date: { text: 'Sat 14 Nov', day: 14, month: 11, weekday: 6 },
					time: '09:00',
					timeText: '09:00',
				}),
			]),
		);
		await read('Regional gala moved to Sat 14 Nov 09:00');
		const listed = (await k.route('core.listDrafts').call({
			query: { status: 'pending', limit: 10 },
			actor: admin.actor,
		})) as { actionId: string; mayExist: boolean }[];
		expect(listed.find((d) => d.actionId === 'calendar.createEvent')?.mayExist).toBe(true);
	});

	it('moves the event that is there when the model reads the news as a move', async () => {
		k.llm.respond(
			understood([
				mention('calendar.eventChange', {
					target: 'Regional gala',
					date: { text: 'Sat 14 Nov', day: 14, month: 11, weekday: 6 },
					time: '09:00',
					timeText: '09:00',
				}),
			]),
		);
		await read('Regional gala moved to Sat 14 Nov 09:00');
		const [draft] = await drafts();
		expect(draft).toMatchObject({
			actionId: 'calendar.changeEvent',
			input: { date: '2026-11-14', startTime: '09:00', label: 'Regional Gala' },
		});
	});

	it('offers to move the event that is there, and moves it instead of adding a second', async () => {
		// The same real output: the card offers the move, and choosing it moves the gala.
		k.llm.respond(
			understood([
				mention('calendar.event', {
					title: 'Regional gala',
					date: { text: 'Sat 14 Nov', day: 14, month: 11, weekday: 6 },
					time: '09:00',
					timeText: '09:00',
				}),
			]),
		);
		await read('Regional gala moved to Sat 14 Nov 09:00');
		const [draft] = (await k.route('core.listDrafts').call({
			query: { sourceKind: 'inbox', limit: 50 },
			actor: admin.actor,
		})) as { id: string; actionId: string; instead: object | null }[];
		expect(draft?.actionId).toBe('calendar.createEvent');
		expect(draft?.instead).toMatchObject({
			actionId: 'calendar.changeEvent',
			input: { label: 'Regional Gala', date: '2026-11-14', startTime: '09:00' },
			at: { date: '2026-11-07', time: '18:00' },
		});

		const id = draft?.id as string;
		const replaced = await k
			.route('core.replaceDraft')
			.call({ actor: admin.actor, params: { draftId: id } });
		expect(replaced).toMatchObject({ actionId: 'calendar.changeEvent', status: 'pending' });
		expect((await k.runner.approveDraft(id, admin.actor)).status).toBe('applied');
		const november = (await k
			.route('calendar.listOccurrences')
			.call({ query: { from: '2026-11-01', to: '2026-11-30' } })) as {
			title: string;
			start: number;
			end: number;
		}[];
		// One gala, on the new day, as long as it was.
		expect(november).toEqual([
			expect.objectContaining({
				title: 'Regional Gala',
				start: epochOf('2026-11-14', '09:00', TZ),
				end: epochOf('2026-11-14', '13:00', TZ),
			}),
		]);
	});
});

describe('the person who shared the item', () => {
	it('is who a message about "me" is for, marked for a look when it names nobody', async () => {
		k.llm.respond(
			understood([
				mention('calendar.event', {
					title: 'Dentist',
					forMe: true,
					date: { text: 'Thursday 8 October', day: 8, month: 10, weekday: 4 },
					time: '16:00',
				}),
			]),
		);
		await read('dentist for me on Thursday 8 October at 16:00');
		const [draft] = await drafts();
		expect(draft?.input.memberIds).toEqual([admin.member.id]);
		// Nobody is named: the model may have given it to the sharer because nobody else was.
		expect(draft?.uncertainFields).toContain('memberIds');
	});

	it('still marks someone else the item never names', async () => {
		const ellie = await k.member('member', 'Ellie');
		k.llm.respond(
			understood([
				mention('calendar.event', {
					title: 'Dentist',
					people: ['Ellie'],
					date: { text: 'Thursday 8 October', day: 8, month: 10 },
					time: '16:00',
				}),
			]),
		);
		await read('dentist on Thursday 8 October at 16:00');
		const [draft] = await drafts();
		expect(draft?.input.memberIds).toEqual([ellie.member.id]);
		expect(draft?.uncertainFields).toContain('memberIds');
	});
});
