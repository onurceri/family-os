import { FamosError } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryEntry, Obligation } from '../src/contract/index.ts';
import { applied, at, CAR, createKernel, OTHER_CAR, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;

beforeEach(async () => {
	({ k } = await createKernel());
	admin = await person(k, 'admin');
});
afterEach(() => k.close());

const add = (input: Record<string, unknown>, actor = admin.actor, record = CAR) =>
	applied<Obligation>(
		k,
		'records.addObligation',
		{
			recordId: record,
			recordKind: 'vehicle',
			recordName: 'Golf',
			recordUrl: `/vehicles/${record}`,
			title: 'Car insurance',
			dueDate: '2026-11-20',
			...input,
		},
		actor,
	);
const complete = (id: string, input: Record<string, unknown> = {}, actor = admin.actor) =>
	applied<Obligation>(k, 'records.completeObligation', { id, ...input }, actor);
const open = (record = CAR): Promise<Obligation[]> =>
	k.route('records.listObligations').call({ query: { recordId: record, status: 'open' } });
const archived = (record = CAR): Promise<Obligation[]> =>
	k.route('records.listObligations').call({ query: { recordId: record, status: 'archived' } });
const history = (id: string): Promise<HistoryEntry[]> =>
	k.route('records.getObligationHistory').call({ params: { obligationId: id } });

describe('adding', () => {
	it('stores an obligation with its defaults and lists it for the record', async () => {
		const o = await add({ every: { years: 1 }, notes: 'Ask for the green card' });
		expect(o).toMatchObject({
			recordId: CAR,
			recordName: 'Golf',
			kind: 'custom',
			dueDate: '2026-11-20',
			every: { years: 1 },
			rrule: 'FREQ=YEARLY;INTERVAL=1',
			leadDays: 14,
			audience: 'records.view',
			assigneeId: null,
			lastDoneOn: null,
			archivedAt: null,
		});
		expect(await open()).toHaveLength(1);
		expect(await open(OTHER_CAR)).toHaveLength(0);
	});

	it('refuses a bad record id, an unknown assignee and a bad date', async () => {
		const fail = (input: Record<string, unknown>) =>
			add(input).then(
				() => null,
				(e: unknown) => e,
			);
		expect(await fail({ recordId: 'car' })).toBeInstanceOf(FamosError);
		expect(await fail({ dueDate: '2026-13-40' })).toBeInstanceOf(FamosError);
		expect(
			await fail({ assigneeId: 'member_00000000-0000-7000-8000-000000000999' }),
		).toBeInstanceOf(FamosError);
		expect(await fail({ every: { months: 1, years: 1 } })).toBeInstanceOf(FamosError);
	});

	it('lists open obligations soonest first', async () => {
		await add({ title: 'Later', dueDate: '2027-01-10' });
		await add({ title: 'Sooner', dueDate: '2026-10-20' });
		expect((await open()).map((o) => o.title)).toEqual(['Sooner', 'Later']);
	});
});

describe('completing', () => {
	it('records history and moves a monthly obligation on the 31st to the next month end', async () => {
		const o = await add({ dueDate: '2026-10-31', every: { months: 1 } });
		const after = await complete(o.id, { note: 'Done at the garage' });
		expect(after).toMatchObject({
			dueDate: '2026-11-30',
			lastDoneOn: '2026-10-06',
			archivedAt: null,
		});
		expect(await history(o.id)).toMatchObject([
			{ dueDate: '2026-10-31', doneOn: '2026-10-06', note: 'Done at the garage', doneBy: admin.id },
		]);
		// Counted from the first date, not from the clamped one.
		k.clock.set(at('2026-11-20', '10:00'));
		expect((await complete(o.id)).dueDate).toBe('2026-12-31');
		expect(await history(o.id)).toHaveLength(2);
	});

	it('handles every N months and yearly repeats, including 29 February', async () => {
		const quarter = await add({ title: 'Service', dueDate: '2026-11-30', every: { months: 3 } });
		expect((await complete(quarter.id)).dueDate).toBe('2027-02-28');

		k.clock.set(at('2028-02-20', '10:00'));
		const leap = await add({ title: 'Inspection', dueDate: '2028-02-29', every: { years: 1 } });
		expect((await complete(leap.id)).dueDate).toBe('2029-02-28');
		k.clock.set(at('2029-02-20', '10:00'));
		expect((await complete(leap.id)).dueDate).toBe('2030-02-28');
	});

	it('keeps the schedule when done late, and skips missed periods', async () => {
		const yearly = await add({
			title: 'Car insurance',
			dueDate: '2026-09-01',
			every: { years: 1 },
		});
		expect((await complete(yearly.id)).dueDate).toBe('2027-09-01');
		const monthly = await add({ title: 'Check', dueDate: '2026-06-15', every: { months: 1 } });
		expect((await complete(monthly.id)).dueDate).toBe('2026-10-15');
	});

	it('does not move a repeat that was done early past the next period', async () => {
		const o = await add({ dueDate: '2026-12-01', every: { years: 1 } });
		expect((await complete(o.id)).dueDate).toBe('2027-12-01');
	});

	it('archives a one-off as done', async () => {
		const o = await add({ title: 'Warranty ends', dueDate: '2026-10-20' });
		const after = await complete(o.id, { doneOn: '2026-10-05' });
		expect(after.archivedAt).not.toBeNull();
		expect(after.lastDoneOn).toBe('2026-10-05');
		expect(await open()).toHaveLength(0);
		expect(await archived()).toHaveLength(1);
		expect(await history(o.id)).toHaveLength(1);
	});

	it('ignores a stale or repeated completion', async () => {
		const o = await add({ dueDate: '2026-10-20', every: { months: 1 } });
		await complete(o.id, { dueDate: '2026-10-20' });
		// A second tap on the screen that still shows the old date.
		const again = await complete(o.id, { dueDate: '2026-10-20' });
		expect(again.dueDate).toBe('2026-11-20');
		expect(await history(o.id)).toHaveLength(1);
		const oneOff = await add({ title: 'Once', dueDate: '2026-10-21' });
		await complete(oneOff.id);
		await complete(oneOff.id);
		expect(await history(oneOff.id)).toHaveLength(1);
	});
});

describe('changing and removing', () => {
	it('keeps counting from the first date unless the date or repeat changes', async () => {
		const o = await add({ dueDate: '2026-01-31', every: { months: 1 } });
		const edit = (obligation: Record<string, unknown>) =>
			applied<Obligation>(k, 'records.updateObligation', { id: o.id, obligation }, admin.actor);
		const base = { title: 'Renamed', dueDate: '2026-01-31', every: { months: 1 }, leadDays: 7 };
		await edit(base);
		k.clock.set(at('2026-01-20', '10:00'));
		expect((await complete(o.id)).dueDate).toBe('2026-02-28');
		// Moving the date starts a new series from it.
		const moved = await edit({ ...base, dueDate: '2026-03-15' });
		expect(moved).toMatchObject({ title: 'Renamed', dueDate: '2026-03-15', leadDays: 7 });
		k.clock.set(at('2026-03-01', '10:00'));
		expect((await complete(o.id)).dueDate).toBe('2026-04-15');
	});

	it('keeps the kind and audience when an edit leaves them out', async () => {
		const o = await add({ kind: 'liability_insurance', audience: 'records.edit' });
		const after = await applied<Obligation>(
			k,
			'records.updateObligation',
			{ id: o.id, obligation: { title: 'Car insurance', dueDate: '2026-12-01', leadDays: 30 } },
			admin.actor,
		);
		expect(after).toMatchObject({
			kind: 'liability_insurance',
			audience: 'records.edit',
			leadDays: 30,
		});
	});

	it('keeps showing and repeating an obligation whose preset no longer exists', async () => {
		// Presets removed since (earthquake insurance, kasko, MTV…): the kind is
		// only a label for the person who made it; the stored title, repeat and dates are what count.
		const now = Date.now();
		await k.ctx.db
			.withTables<{ records_obligations: Record<string, string | number | null> }>()
			.insertInto('records_obligations')
			.values({
				id: 'obligation_00000000-0000-7000-8000-0000000000bb',
				record_id: CAR,
				record_kind: 'vehicle',
				record_name: 'Golf',
				record_url: `/vehicles/${CAR}`,
				kind: 'motor_vehicle_tax',
				title: 'MTV',
				due_date: '2026-12-01',
				rrule: 'FREQ=MONTHLY;INTERVAL=6',
				rrule_start: '2026-12-01',
				lead_days: 14,
				audience: 'records.view',
				created_at: now,
				updated_at: now,
			})
			.execute();
		const [old] = await open();
		expect(old).toMatchObject({
			kind: 'motor_vehicle_tax',
			title: 'MTV',
			every: { months: 6 },
			leadDays: 14,
		});
		k.clock.set(at('2026-12-01', '10:00'));
		expect((await complete(old?.id as string)).dueDate).toBe('2027-06-01');
		// And it can be edited without touching the kind.
		const after = await applied<Obligation>(
			k,
			'records.updateObligation',
			{ id: old?.id, obligation: { title: 'Road tax', dueDate: '2027-06-01', leadDays: 20 } },
			admin.actor,
		);
		expect(after).toMatchObject({ kind: 'motor_vehicle_tax', title: 'Road tax' });
	});

	it('removes an obligation with its history', async () => {
		const o = await add({ every: { years: 1 } });
		await complete(o.id);
		await applied(k, 'records.removeObligation', { id: o.id }, admin.actor);
		expect(await open()).toHaveLength(0);
		expect(await history(o.id)).toHaveLength(0);
	});

	it('keeps names current without disturbing reminders', async () => {
		const o = await add({});
		const before = (await open())[0]?.updatedAt;
		await applied(
			k,
			'records.renameRecord',
			{ recordId: CAR, name: 'Polo', url: `/cars/${CAR}` },
			admin.actor,
		);
		const [after] = await open();
		expect(after).toMatchObject({ id: o.id, recordName: 'Polo', recordUrl: `/cars/${CAR}` });
		expect(after?.updatedAt).toBe(before);
	});
});

describe('archiving a record', () => {
	it('archives the obligations of that record only, and is repeatable', async () => {
		await add({ title: 'A' });
		await add({ title: 'B' });
		await add({ title: 'C' }, admin.actor, OTHER_CAR);
		const first = await applied<{ obligations: number }>(
			k,
			'records.archiveForRecord',
			{ recordId: CAR },
			admin.actor,
		);
		expect(first.obligations).toBe(2);
		expect(await open()).toHaveLength(0);
		expect(await open(OTHER_CAR)).toHaveLength(1);
		const second = await applied<{ obligations: number }>(
			k,
			'records.archiveForRecord',
			{ recordId: CAR },
			admin.actor,
		);
		expect(second.obligations).toBe(0);
		// Not "done": archived with the record.
		expect((await archived())[0]?.lastDoneOn).toBeNull();
	});
});

describe('upcoming', () => {
	it('lists overdue and soon-due obligations of every record, not later or archived ones', async () => {
		await add({ title: 'Overdue', dueDate: '2026-10-01' });
		await add({ title: 'Soon', dueDate: '2026-10-30' }, admin.actor, OTHER_CAR);
		await add({ title: 'Edge', dueDate: '2026-11-05' });
		await add({ title: 'Far', dueDate: '2026-11-06' });
		const done = await add({ title: 'Done', dueDate: '2026-10-10' });
		await complete(done.id);
		const rows: Obligation[] = await k.route('records.listUpcoming').call({ query: { days: 30 } });
		expect(rows.map((o) => o.title)).toEqual(['Overdue', 'Soon', 'Edge']);
		expect(rows[1]).toMatchObject({ recordName: 'Golf', recordId: OTHER_CAR });
	});
});

describe('dates that lapse', () => {
	const upcoming = (): Promise<Obligation[]> =>
		k.route('records.listUpcoming').call({ query: { days: 30 } });

	it('lists a lapsing date until its day, never as late, and drops it afterwards', async () => {
		await add({ title: 'Warranty ends', dueDate: '2026-10-20', lapses: true });
		await add({ title: 'Late duty', dueDate: '2026-10-01' });
		expect((await upcoming()).map((o) => [o.title, o.lapses])).toEqual([
			['Late duty', false],
			['Warranty ends', true],
		]);

		k.clock.set(at('2026-10-20', '23:00'));
		expect((await upcoming()).map((o) => o.title)).toEqual(['Late duty', 'Warranty ends']);
		const forAi = await applied<{ obligations: { title: string; overdue: boolean }[] }>(
			k,
			'records.upcoming',
			{ days: 30 },
			admin.actor,
		);
		expect(forAi.obligations.map((o) => [o.title, o.overdue])).toEqual([
			['Late duty', true],
			['Warranty ends', false],
		]);

		k.clock.set(at('2026-10-21', '00:30'));
		expect((await upcoming()).map((o) => o.title)).toEqual(['Late duty']);
		const context = await applied<{ items: { label: string }[] }>(
			k,
			'records.aiContext',
			{},
			admin.actor,
		);
		expect(context.items.map((i) => i.label)).toEqual(['Late duty (Golf)']);
		// The record's own page still has it.
		expect((await open()).map((o) => o.title)).toEqual(['Late duty', 'Warranty ends']);
	});

	it('never repeats, and keeps lapsing when a change does not say otherwise', async () => {
		const o = await add({ dueDate: '2026-12-01', lapses: true, every: { years: 1 } });
		expect(o).toMatchObject({ lapses: true, every: null, rrule: null });
		const moved = await applied<Obligation>(
			k,
			'records.updateObligation',
			{ id: o.id, obligation: { title: 'Warranty ends', dueDate: '2027-01-01' } },
			admin.actor,
		);
		expect(moved).toMatchObject({ lapses: true, dueDate: '2027-01-01' });
		const duty = await applied<Obligation>(
			k,
			'records.updateObligation',
			{ id: o.id, obligation: { title: 'Renew', dueDate: '2027-01-01', lapses: false } },
			admin.actor,
		);
		expect(duty.lapses).toBe(false);
		expect((await add({})).lapses).toBe(false);
	});

	it('keeps the lead time, assignee and notes when a change leaves them out, and clears them on null', async () => {
		const o = await add({ leadDays: 7, assigneeId: admin.id, notes: 'Green card' });
		const kept = await applied<Obligation>(
			k,
			'records.updateObligation',
			{ id: o.id, obligation: { title: 'Car insurance', dueDate: '2026-11-21' } },
			admin.actor,
		);
		expect(kept).toMatchObject({ leadDays: 7, assigneeId: admin.id, notes: 'Green card' });
		const cleared = await applied<Obligation>(
			k,
			'records.updateObligation',
			{
				id: o.id,
				obligation: {
					title: 'Car insurance',
					dueDate: '2026-11-21',
					assigneeId: null,
					notes: null,
				},
			},
			admin.actor,
		);
		expect(cleared).toMatchObject({ leadDays: 7, assigneeId: null, notes: null });
	});
});

describe('who may change what', () => {
	it('lets members with records.edit change directly and turns a supervised change into a draft', async () => {
		const kid = await person(k, 'supervised', 'Elif');
		const r = await k.runner.invoke(
			'records.addObligation',
			{
				recordId: CAR,
				recordKind: 'vehicle',
				recordName: 'Golf',
				title: 'Tyres',
				dueDate: '2026-11-01',
			},
			kid.actor,
		);
		expect(r.status).toBe('drafted');
		expect(await open()).toHaveLength(0);
		if (r.status !== 'drafted') return;
		await k.runner.approveDraft(r.draftId, admin.actor);
		expect((await open()).map((o) => o.title)).toEqual(['Tyres']);

		const o = (await open())[0] as Obligation;
		const done = await k.runner.invoke('records.completeObligation', { id: o.id }, kid.actor);
		expect(done.status).toBe('drafted');
		expect((await open())[0]?.lastDoneOn).toBeNull();
	});

	it('refuses guests, and declares view access on every read', async () => {
		const guest = await person(k, 'guest');
		await expect(
			k.runner.invoke(
				'records.addObligation',
				{
					recordId: CAR,
					recordKind: 'vehicle',
					recordName: 'Golf',
					title: 'x',
					dueDate: '2026-11-01',
				},
				guest.actor,
			),
		).rejects.toMatchObject({ code: 'forbidden' });
		for (const id of [
			'records.listObligations',
			'records.getObligationHistory',
			'records.listUpcoming',
			'records.listDocuments',
			'records.getDocumentFile',
		]) {
			expect(k.registry.routes.find((r) => r.route.operationId === id)?.route.requires).toBe(
				'records.view',
			);
		}
	});

	it('offers adding and completing to the AI, and nothing else', () => {
		expect(
			k.ctx.actions
				.aiCatalog()
				.filter((a) => a.id.startsWith('records.'))
				.map((a) => a.id)
				.sort(),
		).toEqual(['records.addObligation', 'records.completeObligation']);
	});
});

describe('completing with a date from the document', () => {
	it('moves a repeating obligation to that date and counts the series from there', async () => {
		const o = await add({ title: 'Car insurance', dueDate: '2026-11-01', every: { years: 1 } });
		const done = await complete(o.id, { doneOn: '2026-10-06', nextDueDate: '2027-03-12' });
		expect(done).toMatchObject({ dueDate: '2027-03-12', lastDoneOn: '2026-10-06' });
		// The series now follows the new date: the next completion goes a year on from it.
		const again = await complete(o.id, { doneOn: '2027-03-10' });
		expect(again.dueDate).toBe('2028-03-12');
		expect(await history(o.id)).toHaveLength(2);
	});

	it('does nothing when the date asked for is already the due date', async () => {
		const o = await add({ every: { years: 1 } });
		await complete(o.id, { nextDueDate: '2027-03-12' });
		await complete(o.id, { nextDueDate: '2027-03-12' });
		expect(await history(o.id)).toHaveLength(1);
	});

	it('refuses a date that is not after the day it was done, and keeps a one-off open', async () => {
		const o = await add({});
		await expect(
			applied(
				k,
				'records.completeObligation',
				{ id: o.id, nextDueDate: '2026-10-06' },
				admin.actor,
			),
		).rejects.toBeInstanceOf(FamosError);
		const done = await complete(o.id, { nextDueDate: '2027-01-01' });
		expect(done).toMatchObject({ dueDate: '2027-01-01', archivedAt: null });
	});
});

describe('AI context', () => {
	it('lists open obligations with what the model needs and no ids in the text', async () => {
		await add({ title: 'Car insurance', dueDate: '2026-11-01', every: { years: 1 } });
		const out = await applied<{ kind: string; items: { label: string; details: string }[] }>(
			k,
			'records.aiContext',
			{},
			{ kind: 'ai', source: 'inbox' },
		);
		expect(out).toMatchObject({
			kind: 'obligation',
			items: [{ label: 'Car insurance (Golf)', details: 'due 2026-11-01, every year' }],
		});
	});
});

describe('taking a completion back', () => {
	const AI = { kind: 'ai', source: 'inbox' } as const;
	const anchorOf = async (id: string) =>
		(
			await k.ctx.db
				.withTables<{ records_obligations: { id: string; rrule_start: string | null } }>()
				.selectFrom('records_obligations')
				.select('rrule_start')
				.where('id', '=', id)
				.executeTakeFirstOrThrow()
		).rrule_start;

	it('restores the due date, the last done day and the history when an approved suggestion is undone', async () => {
		const o = await add({ title: 'Car insurance', dueDate: '2026-11-01', every: { years: 1 } });
		await complete(o.id, { doneOn: '2025-11-01', dueDate: '2026-11-01' });
		const before = (await open())[0] as Obligation;
		expect(before.dueDate).toBe('2027-11-01');

		const r = await k.runner.invoke(
			'records.completeObligation',
			{ id: o.id, doneOn: '2026-10-06', nextDueDate: '2028-03-12' },
			AI,
			{ draft: { sourceKind: 'inbox', sourceId: 'item', summary: 'Insurance renewed' } },
		);
		expect(r.status).toBe('drafted');
		if (r.status !== 'drafted') return;
		await k.runner.approveDraft(r.draftId, admin.actor);
		expect((await open())[0]).toMatchObject({ dueDate: '2028-03-12', lastDoneOn: '2026-10-06' });
		expect(await history(o.id)).toHaveLength(2);

		expect((await k.runner.undoDraft(r.draftId, admin.actor)).status).toBe('undone');
		expect((await open())[0]).toMatchObject({
			dueDate: before.dueDate,
			lastDoneOn: before.lastDoneOn,
			archivedAt: null,
		});
		expect(await history(o.id)).toHaveLength(1);
		// The series counts from its old anchor again.
		expect(await anchorOf(o.id)).toBe('2026-11-01');
		// Undoing again changes nothing.
		expect((await k.runner.undoDraft(r.draftId, admin.actor)).status).toBe('undone');
		expect(await history(o.id)).toHaveLength(1);
	});

	it('reopens a one-off, and is idempotent when run twice', async () => {
		const o = await add({ title: 'Warranty ends', dueDate: '2026-10-20' });
		const done = await applied<Obligation & { before: Record<string, unknown> | null }>(
			k,
			'records.completeObligation',
			{ id: o.id, doneOn: '2026-10-05' },
			admin.actor,
		);
		expect(done.before).toMatchObject({ dueDate: '2026-10-20', lastDoneOn: null });
		const undo = { id: o.id, ...done.before };
		await applied(k, 'records.undoCompletion', undo, admin.actor);
		await applied(k, 'records.undoCompletion', undo, admin.actor);
		expect(await open()).toMatchObject([
			{ title: 'Warranty ends', dueDate: '2026-10-20', lastDoneOn: null, archivedAt: null },
		]);
		expect(await archived()).toHaveLength(0);
		expect(await history(o.id)).toHaveLength(0);
	});

	it('has nothing to take back when a completion changed nothing', async () => {
		const o = await add({ title: 'Once', dueDate: '2026-10-21' });
		await complete(o.id);
		const again = await applied<{ before: unknown }>(
			k,
			'records.completeObligation',
			{ id: o.id },
			admin.actor,
		);
		expect(again.before).toBeNull();
	});

	it('is not offered to the AI', () => {
		expect(k.ctx.actions.aiCatalog().some((a) => a.id === 'records.undoCompletion')).toBe(false);
	});
});

describe('an AI proposing that a duty is done', () => {
	const AI = { kind: 'ai', source: 'inbox' } as const;

	it('is refused without a day it was done or a date it runs to', async () => {
		// Real mistake: "your car insurance is due for renewal … ends on 20 October" was proposed
		// as done.
		const o = await add({ title: 'Car insurance', dueDate: '2026-10-20', every: { years: 1 } });
		await expect(
			k.runner.invoke(
				'records.completeObligation',
				{ id: o.id, dueDate: '2026-10-20', label: 'Car insurance (Golf)' },
				AI,
			),
		).rejects.toMatchObject({
			code: 'conflict',
			message: expect.stringContaining('Nothing says when Car insurance was done'),
		});
	});

	it('is drafted when the item gives the date it now runs to, or the day it was done', async () => {
		const o = await add({ title: 'Car insurance', dueDate: '2026-10-20', every: { years: 1 } });
		const renewed = await k.runner.invoke(
			'records.completeObligation',
			{ id: o.id, nextDueDate: '2027-10-19' },
			AI,
		);
		expect(renewed.status).toBe('drafted');
		const paid = await k.runner.invoke(
			'records.completeObligation',
			{ id: o.id, doneOn: '2026-10-06' },
			AI,
		);
		expect(paid.status).toBe('drafted');
	});

	it('leaves people free to mark it done for today', async () => {
		const o = await add({ title: 'Car insurance', dueDate: '2026-10-20', every: { years: 1 } });
		await complete(o.id);
		expect((await history(o.id)).length).toBe(1);
	});
});
