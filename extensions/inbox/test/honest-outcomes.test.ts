import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import records from '@famos/ext-records/server';
import { FamosError, systemActor } from '@famos/sdk';
import {
	createTestKernel,
	mention,
	openDatabase,
	runMigrations,
	type TestKernel,
	understood,
} from '@famos/testing';
import { epochOf } from '@famos/time';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/contract/index.ts';
import inbox from '../src/server/index.ts';
import { skipOf } from '../src/server/process.ts';
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
		// What a model made of Leo's message: the football with "new" as its amount, and the ice
		// cream that is already on the list.
		k.llm.respond(
			understood([
				mention('lists.shoppingItem', { title: 'Ice cream', variant: 'frozen' }),
				mention('lists.shoppingItem', { title: 'Football', quantity: 'new' }),
			]),
		);
		await read('ice cream and a new football pls', leo.actor);
		expect(k.llm.calls).toHaveLength(1);
		expect(await latest(leo.actor)).toMatchObject({
			proposals: 1,
			skipped: 1,
			skippedUnknown: 0,
			skips: [{ reason: 'already', subject: 'Ice cream' }],
		});
		const [football] = await drafts();
		expect(football?.input).toEqual({ items: [{ title: 'Football' }] });
		// A describing word is not an amount: it is left out, and the person may check.
		expect(football?.uncertainFields).toEqual(['items.0.quantity']);
	});

	it('names what was left out when nothing was kept, and reads it again on request', async () => {
		// What a model made of Mara's message while Home was removed: duties on a flat that is not
		// among the records.
		k.llm.respond(
			understood([
				mention('records.duty', {
					title: 'Boiler service',
					about: 'our flat',
					date: { text: 'in March', month: 3 },
				}),
				mention('records.duty', {
					title: 'Flat insurance',
					about: 'the flat',
					date: { text: '1 Dec', day: 1, month: 12 },
				}),
			]),
		);
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
		k.llm.respond(understood([], { label: 'Flat boiler and insurance', intent: 'actionable' }));
		await k.runner.invoke('inbox.retryItem', { id: item.id }, mara.actor);
		await k.worker.drain();
		expect(k.llm.calls).toHaveLength(before + 1);
		expect(await latest()).toMatchObject({ status: 'extracted', proposals: 0, skips: [] });
	});

	it('does not read again an item that gave suggestions', async () => {
		k.llm.respond(understood([mention('lists.shoppingItem', { title: 'Milk' })]));
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
		// The words the suggestion rests on name it when the runner does not.
		expect(skipOf(error('bad_request'), { items: [] }, 'Milk, Bread')).toEqual({
			reason: 'incomplete',
			subject: 'Milk, Bread',
		});
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
		k.llm.respond(understood([], { label: 'x' }));
		await read('football thursday was cancelled');
		expect(system()).toContain('Upcoming calendar events:\n- Football training (');
		expect(system()).toContain('### calendar.eventCancel');
		expect(system()).toContain('Never a new event about the cancellation.');
		expect(JSON.stringify(k.llm.calls)).not.toMatch(/cal_event_[0-9a-f]{8}|event:1/);
	});

	it('turns "football thursday was cancelled" into removing that one date', async () => {
		k.llm.respond(
			understood([
				mention('calendar.eventCancel', {
					target: 'football',
					date: { text: 'thursday', weekday: 4 },
				}),
			]),
		);
		await read('um so football thursday was cancelled?? coach said tell mum');
		const [draft] = await drafts();
		expect(draft).toMatchObject({
			actionId: 'calendar.deleteEvent',
			input: { occurrence: String(epochOf('2026-10-08', '17:30', TZ)) },
		});
		expect(String(draft?.input.id)).toMatch(/^cal_event_/);
		expect((await latest()).skips).toEqual([]);
		await k.runner.approveDraft(draft?.id ?? '', mara.actor);
		const left = (await k.route('calendar.listOccurrences').call({
			query: { from: '2026-10-06', to: '2026-10-16' },
			actor: mara.actor,
		})) as { startDate: string | null; start: number | null }[];
		expect(left).toHaveLength(1);
		expect(left[0]?.start).toBe(epochOf('2026-10-15', '17:30', TZ));
	});

	it('leaves out a removal of an event the calendar does not have', async () => {
		k.llm.respond(
			understood([
				mention('calendar.eventCancel', {
					target: 'piano',
					date: { text: 'thursday', weekday: 4 },
				}),
			]),
		);
		await read('piano thursday is cancelled');
		expect(await drafts()).toEqual([]);
		expect((await latest()).skips).toEqual([{ reason: 'unknown', subject: 'piano' }]);
	});
});

describe('a school letter repeating an event the calendar has', () => {
	it('leaves "Parents\' evening" out as already there when "Parents\' evening at school" is', async () => {
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: "Parents' evening at school", date: '2026-10-20', startTime: '18:00' },
			mara.actor,
		);
		// What a model read from Tom's letter: the same evening, under a shorter title.
		k.llm.respond(
			understood([
				mention('calendar.event', {
					title: "Parents' evening",
					date: { text: '20 October', day: 20, month: 10 },
					time: '18:00',
				}),
			]),
		);
		await read("Parents' evening is on 20 October, 18:00 in the school hall.");
		expect(await drafts()).toEqual([]);
		expect((await latest()).skips).toEqual([{ reason: 'already', subject: "Parents' evening" }]);
	});
});

describe('people named in notes', () => {
	const fee = (notes: string) =>
		understood([
			mention('lists.task', {
				title: 'Pay the trip fee',
				date: { text: 'by 23 October', day: 23, month: 10 },
				notes,
			}),
		]);
	const LETTER = 'Year 7 trip: the cost is 14 EUR, payable by 23 October.';

	it('marks the notes "check this" when they name someone the item never names', async () => {
		k.llm.respond(fee('For Ivy'));
		await read(LETTER);
		// Code reports it; the model is not asked again.
		expect(k.llm.calls).toHaveLength(1);
		const [draft] = await drafts();
		expect(draft?.input.notes).toBe('For Ivy');
		expect(draft?.uncertainFields).toContain('notes');
	});

	it('leaves notes alone that name nobody, or someone the item names', async () => {
		k.llm.respond(fee('Fee: 14 EUR'));
		await read(LETTER);
		k.llm.respond(fee('For Ivy'));
		await read(`${LETTER} Ivy is going.`);
		const all = await drafts();
		expect(all.map((d) => d.uncertainFields.includes('notes'))).toEqual([false, false]);
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
