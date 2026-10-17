import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import records from '@famos/ext-records/server';
import { FamosError, systemActor } from '@famos/sdk';
import { createTestKernel, openDatabase, runMigrations, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/contract/index.ts';
import inbox from '../src/server/index.ts';
import { describingQuantities, membersNamedInDetails, skipOf } from '../src/server/process.ts';
import { type ItemRow, migrations, toItem } from '../src/server/store.ts';

const TZ = 'Europe/Ljubljana';
let k: TestKernel;
let mara: Awaited<ReturnType<TestKernel['member']>>;
let leo: Awaited<ReturnType<TestKernel['member']>>;
let ivy: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar, lists, records, inbox] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-06', '10:00', TZ)); // Tuesday
	mara = await k.member('admin', 'Mara Novak');
	ivy = await k.member('supervised', 'Ivy Novak');
	leo = await k.member('supervised', 'Leo Novak');
	await k.runner.invoke(
		'core.updateMember',
		{ memberId: ivy.member.id, about: '13 years old, plays football, does piano' },
		mara.actor,
	);
});
afterEach(() => k.close());

const read = async (text: string, actor = mara.actor) => {
	const item = await k.route('inbox.createItem').call({
		body: { channel: 'text', text },
		files: [],
		actor,
	});
	await k.worker.drain();
	return item;
};
const latest = async (actor = mara.actor): Promise<InboxItem> =>
	(
		(await k.route('inbox.listItems').call({ query: { limit: 1 }, actor })) as InboxItem[]
	)[0] as InboxItem;
type ListedDraft = {
	id: string;
	actionId: string;
	input: Record<string, unknown>;
	uncertainFields: string[];
	mayExist: boolean | 'some';
};
const drafts = (): Promise<ListedDraft[]> =>
	k.route('core.listDrafts').call({ query: { sourceKind: 'inbox', limit: 50 }, actor: mara.actor });
const system = () => k.llm.calls.at(-1)?.system ?? '';

describe('why a suggestion was left out', () => {
	it('says an item already on the list was already there, not that it was incomplete', async () => {
		await k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'Ice cream' }] }, leo.actor);
		// What the model made of Leo's message: the football with "new" as its amount, and the ice
		// cream (already on the list) "put back on the list", which the list refuses.
		const answer = (quantity?: string) => ({
			summary: 'Ice cream and football request',
			kind: 'actionable',
			proposals: [
				{
					action: 'lists.addShoppingItems',
					input: { items: [{ title: 'Football', ...(quantity && { quantity }) }] },
					confidence: 0.8,
				},
				{
					action: 'lists.checkShoppingItem',
					input: { id: 'shop_item:1', done: false, label: 'ice cream' },
					confidence: 0.6,
				},
			],
		});
		// Asked about the "new", the model leaves it out.
		k.llm.respond(answer('new'), answer());
		await read('ice cream and a new football pls', leo.actor);
		expect(k.llm.calls[1]?.prompt).toContain(
			'gives "new" as the quantity of Football. A quantity is only an amount',
		);
		expect(await latest(leo.actor)).toMatchObject({
			proposals: 1,
			skipped: 1,
			skippedUnknown: 0,
			skips: [{ reason: 'already', subject: 'Ice cream' }],
		});
		const [football] = await drafts();
		expect(football?.input).toMatchObject({ items: [{ title: 'Football' }] });
		expect(JSON.stringify(football?.input)).not.toContain('new');
		// The model is told that something already listed is added as usual, never unticked, and
		// that a describing word is not an amount.
		expect(system()).toContain('never tick it off or untick it for that');
		expect(system()).toContain('Words that describe the thing ("new", "big"');
	});

	it('asks about one-word quantities without a number only', () => {
		expect(
			describingQuantities({
				items: [
					{ title: 'Football', quantity: 'new' },
					{ title: 'Milk', quantity: '2 litres' },
					{ title: 'Eggs', quantity: 'a dozen' },
					{ title: 'Flour', quantity: '2kg' },
					{ title: 'Bread' },
				],
			}),
		).toEqual([{ quantity: 'new', of: 'Football' }]);
	});

	it('names what was left out when nothing was kept, and reads it again on request', async () => {
		// What the model made of Mara's message while Home was removed: duties on a flat that is
		// not among the records.
		const duty = (title: string, dueDate: string) => ({
			action: 'records.addObligation',
			input: { recordId: 'home:1', recordKind: 'home', recordName: 'Our flat', title, dueDate },
			dateText: title === 'Boiler service' ? 'in March' : '1 Dec',
			confidence: 0.7,
		});
		k.llm.respond({
			summary: 'Flat boiler and insurance',
			kind: 'actionable',
			proposals: [duty('Boiler service', '2027-03-01'), duty('Flat insurance', '2026-12-01')],
		});
		const item = await read(
			'Boiler service for our flat is due in March, the gas man said. Also the flat insurance renews 1 Dec.',
		);
		expect(await latest()).toMatchObject({
			status: 'extracted',
			proposals: 0,
			skips: [
				{ reason: 'unknown', subject: 'Boiler service' },
				{ reason: 'unknown', subject: 'Flat insurance' },
			],
		});

		const before = k.llm.calls.length;
		k.llm.respond({ summary: 'Flat boiler and insurance', kind: 'actionable', proposals: [] });
		await k.runner.invoke('inbox.retryItem', { id: item.id }, mara.actor);
		await k.worker.drain();
		expect(k.llm.calls).toHaveLength(before + 1);
		expect(await latest()).toMatchObject({ status: 'extracted', proposals: 0, skips: [] });
	});

	it('does not read again an item that gave suggestions', async () => {
		k.llm.respond({
			summary: 'Milk',
			proposals: [
				{ action: 'lists.addShoppingItems', input: { items: [{ title: 'Milk' }] }, confidence: 1 },
			],
		});
		const item = await read('milk');
		await k.runner.invoke('inbox.retryItem', { id: item.id }, mara.actor);
		await k.worker.drain();
		expect(k.llm.calls).toHaveLength(1);
		expect(await drafts()).toHaveLength(1);
	});

	it('maps each refusal to the reason a person reads', () => {
		const error = (code: FamosError['code'], details?: unknown) =>
			new FamosError(code, 'x', details);
		const input = { title: 'Football' };
		expect(skipOf(error('conflict', { refused: 'settled', subject: 'Ice cream' }), {})).toEqual({
			reason: 'already',
			subject: 'Ice cream',
		});
		expect(skipOf(error('conflict', { refused: 'other_target', subject: 'hooks' }), input)).toEqual(
			{ reason: 'unknown', subject: 'hooks' },
		);
		expect(skipOf(error('forbidden'), input)).toEqual({
			reason: 'not_allowed',
			subject: 'Football',
		});
		expect(skipOf(error('bad_request', { properties: { id: { errors: ['x'] } } }), {})).toEqual({
			reason: 'unknown',
			subject: null,
		});
		expect(skipOf(error('bad_request', { properties: { date: {} } }), input)).toEqual({
			reason: 'incomplete',
			subject: 'Football',
		});
		expect(skipOf(error('conflict', { refused: 'no_label' }), input).reason).toBe('incomplete');
	});
});

describe('news about an event already on the calendar', () => {
	beforeEach(async () => {
		await k.runner.invoke(
			'calendar.createEvent',
			{
				title: 'Football training',
				date: '2026-10-08',
				startTime: '17:30',
				endTime: '19:00',
				recurrence: { freq: 'weekly', byDay: ['TH'] },
			},
			mara.actor,
		);
	});

	it('shows the model the upcoming events with their dates, and how to cancel one date', async () => {
		k.llm.respond({ summary: 'x', proposals: [] });
		await read('football thursday was cancelled');
		expect(system()).toContain('Upcoming calendar events:');
		expect(system()).toContain(
			'- Football training (event:1): repeats: 2026-10-08 17:30, 2026-10-15 17:30, 2026-10-22 17:30, 2026-10-29 17:30; set occurrence to the date for one of them',
		);
		expect(system()).toContain('Never add an event named after the news ("Football cancelled"');
		expect(JSON.stringify(k.llm.calls)).not.toMatch(/cal_event_[0-9a-f]{8}/);
	});

	it('keeps the removal when the model leaves out its words for the event', async () => {
		// The real model's answer: the right event and date, but no label, which the runner refuses
		// from an AI. The text names the event, so its own title is used.
		k.llm.respond({
			summary: 'Football cancellation and shopping list',
			kind: 'actionable',
			proposals: [
				{
					action: 'calendar.deleteEvent',
					input: { id: 'event:1', occurrence: '2026-10-08' },
					confidence: 1,
					uncertainFields: [],
					dateText: 'thursday',
				},
			],
		});
		await read('um so football thursday was cancelled?? coach said tell mum');
		const [draft] = await drafts();
		expect(draft).toMatchObject({
			actionId: 'calendar.deleteEvent',
			input: { label: 'Football training' },
		});
		expect((await latest()).skips).toEqual([]);
	});

	it('still leaves out a removal of an event the text does not name', async () => {
		k.llm.respond({
			summary: 'Piano cancelled',
			kind: 'actionable',
			proposals: [
				{
					action: 'calendar.deleteEvent',
					input: { id: 'event:1', occurrence: '2026-10-08' },
					confidence: 0.5,
					dateText: 'thursday',
				},
			],
		});
		await read('piano thursday is cancelled');
		expect(await drafts()).toEqual([]);
		expect((await latest()).skips).toEqual([{ reason: 'unknown', subject: null }]);
	});

	it('turns "football thursday was cancelled" into removing that one date', async () => {
		k.llm.respond({
			summary: 'Football cancelled',
			kind: 'actionable',
			proposals: [
				{
					action: 'calendar.deleteEvent',
					input: { id: 'event:1', occurrence: '2026-10-08', label: 'football' },
					dateText: 'thursday',
					confidence: 0.8,
				},
			],
		});
		await read('um so football thursday was cancelled?? coach said tell mum');
		const [draft] = await drafts();
		expect(draft).toMatchObject({
			actionId: 'calendar.deleteEvent',
			input: { occurrence: String(epochOf('2026-10-08', '17:30', TZ)) },
		});
		expect(String(draft?.input.id)).toMatch(/^cal_event_/);
		await k.runner.approveDraft(draft?.id ?? '', mara.actor);
		const left = (await k.route('calendar.listOccurrences').call({
			query: { from: '2026-10-06', to: '2026-10-16' },
			actor: mara.actor,
		})) as { startDate: string | null; start: number | null }[];
		expect(left).toHaveLength(1);
		expect(left[0]?.start).toBe(epochOf('2026-10-15', '17:30', TZ));
	});
});

describe('a school letter repeating an event the calendar has', () => {
	it('marks "Parents\' evening" as maybe already there when "Parents\' evening at school" is', async () => {
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: "Parents' evening at school", date: '2026-10-20', startTime: '18:00' },
			mara.actor,
		);
		// What the model proposed from Tom's letter: the same evening, under a shorter title.
		k.llm.respond({
			summary: 'Year 7 trip letter',
			kind: 'actionable',
			proposals: [
				{
					action: 'calendar.createEvent',
					input: { title: "Parents' evening", date: '2026-10-20', startTime: '18:00' },
					dateText: '20 October',
					confidence: 0.9,
				},
			],
		});
		await read("Parents' evening moved to 20 October, 18:00 in the school hall.");
		const [draft] = await drafts();
		expect(draft).toMatchObject({ actionId: 'calendar.createEvent', mayExist: true });
	});
});

describe('people named in notes', () => {
	const fee = (notes: string) => ({
		summary: 'Trip',
		kind: 'actionable',
		proposals: [
			{
				action: 'lists.addTask',
				input: { title: 'Pay the trip fee', dueDate: '2026-10-23', notes },
				dateText: 'by 23 October',
				confidence: 0.8,
			},
		],
	});
	const LETTER = 'Year 7 trip: the cost is 14 EUR, payable by 23 October.';

	it('asks the model again when its notes name someone the item never names', async () => {
		k.llm.respond(fee('For Ivy'), fee('Fee: 14 EUR'));
		await read(LETTER);
		expect(k.llm.calls).toHaveLength(2);
		expect(k.llm.calls[1]?.prompt).toContain('names Ivy Novak in notes, but the item never names');
		const [draft] = await drafts();
		expect(draft).toMatchObject({ input: { notes: 'Fee: 14 EUR' } });
		expect(draft?.uncertainFields).not.toContain('notes');
	});

	it('marks the notes "check this" when the guess is still there', async () => {
		k.llm.respond(fee('For Ivy'), fee('For Ivy'));
		await read(LETTER);
		const [draft] = await drafts();
		expect(draft?.uncertainFields).toContain('notes');
	});

	it('matches whole words of names the item does not say, in notes and tags', () => {
		const family = [
			{ id: 'a', displayName: 'Ivy Novak' },
			{ id: 'b', displayName: 'Leo Novak' },
		];
		const named = (input: Record<string, unknown>, text = LETTER) =>
			membersNamedInDetails(input, family, text, 'en');
		expect(named({ notes: 'For Ivy' })).toEqual({ fields: ['notes'], names: ['Ivy Novak'] });
		expect(named({ notes: 'For Ivy' }, 'Ivy has a trip')).toEqual({ fields: [], names: [] });
		// Real model output on Tom's letter: a person as a tag.
		expect(named({ tags: ['school', 'Ivy'] })).toEqual({ fields: ['tags'], names: ['Ivy Novak'] });
		expect(named({ notes: 'Fee: 14 EUR', tags: ['school'] })).toEqual({ fields: [], names: [] });
		expect(named({ title: 'For Ivy' })).toEqual({ fields: [], names: [] });
	});
});

describe('items read before the reasons were kept', () => {
	it('gets an empty list of reasons, and tells its counts as before', async () => {
		const handle = openDatabase({ path: ':memory:' });
		const { '0004_skips': _later, ...before } = migrations;
		await runMigrations(handle.db, [{ scope: 'inbox', migrations: before }]);
		await sql`insert into inbox_items
			(id, channel, files, status, proposals, skipped, skipped_unknown, created_at, updated_at)
			values ('inbox_item_1', 'text', '[]', 'extracted', 0, 3, 1, 1, 1)`.execute(handle.db);
		await runMigrations(handle.db, [{ scope: 'inbox', migrations }]);
		const row = (await sql<ItemRow>`select * from inbox_items`.execute(handle.db))
			.rows[0] as ItemRow;
		expect(row.skips).toBe('[]');
		expect(toItem(row).skips).toEqual([
			{ reason: 'unknown', subject: null },
			{ reason: 'incomplete', subject: null },
			{ reason: 'incomplete', subject: null },
		]);
		handle.close();
	});
});
