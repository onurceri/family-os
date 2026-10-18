import { type Actor, defineAction, defineCapability, type FamosError } from '@famos/sdk';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { hasPassed, nextExpiryAt } from '../src/draft-expiry.ts';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

describe('hasPassed', () => {
	it('is true only for a day before today', () => {
		expect(hasPassed('2026-10-10', '2026-10-11')).toBe(true);
		expect(hasPassed('2025-12-31', '2026-01-01')).toBe(true);
		expect(hasPassed('2026-10-11', '2026-10-11')).toBe(false);
		expect(hasPassed('2026-10-12', '2026-10-11')).toBe(false);
	});

	it('never expires a draft without a day, or with something that is not a day', () => {
		expect(hasPassed(undefined, '2026-10-11')).toBe(false);
		expect(hasPassed('Saturday', '2026-10-11')).toBe(false);
		expect(hasPassed('2026-02-30', '2026-10-11')).toBe(false);
	});
});

describe('nextExpiryAt', () => {
	it('is a few minutes after the coming midnight in the family time zone', () => {
		const tz = 'Europe/Istanbul';
		// 01:30 on the 11th in Istanbul (22:30 UTC on the 10th): the next run is just after the 12th starts.
		const { at, day } = nextExpiryAt(epochOf('2026-10-11', '01:30', tz), tz);
		expect(day).toBe('2026-10-12');
		expect(at).toBe(epochOf('2026-10-12', '00:05', tz));
		expect(nextExpiryAt(epochOf('2026-10-11', '23:59', tz), tz).day).toBe('2026-10-12');
	});
});

/** An action about a day, when one is given. */
const planEdit = defineCapability({ id: 'plans.edit', label: 'plans:cap_edit', level: 'edit' });
const addPlan = defineAction({
	id: 'plans.addPlan',
	title: 'Plan something for a day',
	input: z.object({ title: z.string(), day: z.string().optional() }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: planEdit.id },
	draftDate: (input) => input.day,
	async run() {
		runs++;
		return { ok: true as const };
	},
});
let runs = 0;
const plans = defineTestExtension({
	id: 'plans',
	actions: [addPlan],
	capabilities: [planEdit],
});

const AI: Actor = { kind: 'ai', mode: 'share', source: 'inbox' };
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
beforeEach(async () => {
	runs = 0;
	k = await createTestKernel({ extensions: [plans] });
	admin = await k.member('admin');
	// The harness starts on 2026-01-01 at 09:00 UTC; the family lives in UTC.
});
afterEach(() => k.close());

const propose = async (title: string, day?: string) => {
	const result = await k.runner.invoke('plans.addPlan', { title, ...(day && { day }) }, AI, {
		draft: { sourceKind: 'inbox', sourceId: `item_${title}` },
	});
	if (result.status !== 'drafted') throw new Error('expected a draft');
	return result.draftId;
};
const statusOf = async (id: string) =>
	(
		await k.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.select(['status', 'updated_at'])
			.where('id', '=', id)
			.executeTakeFirstOrThrow()
	).status;
const listed = async (status?: string) =>
	(
		(await k.route('core.listDrafts').call({
			query: { limit: 50, ...(status && { status }) },
			actor: admin.actor,
		})) as { id: string; status: string }[]
	).map((d) => [d.id, d.status]);
const waiting = async () =>
	((await k.route('core.countWaitingDrafts').call({ actor: admin.actor })) as { count: number })
		.count;

describe('suggestions about a day that has passed', () => {
	it('are not shown or counted as waiting, even before the daily job runs', async () => {
		const yesterday = await propose('Dinner', '2025-12-31');
		const today = await propose('Lunch', '2026-01-01');
		const undated = await propose('Call grandma');

		expect(await listed('pending')).toEqual(
			expect.arrayContaining([
				[undated, 'pending'],
				[today, 'pending'],
			]),
		);
		expect(await listed('pending')).toHaveLength(2);
		expect(await listed('expired')).toEqual([[yesterday, 'expired']]);
		expect((await listed()).find(([id]) => id === yesterday)?.[1]).toBe('expired');
		expect(await waiting()).toBe(2);
		// Stored as waiting until the job runs; listing never changes data.
		expect(await statusOf(yesterday)).toBe('pending');
	});

	it('are expired by the job, which keeps today and undated ones, and a second run changes nothing', async () => {
		const yesterday = await propose('Dinner', '2025-12-31');
		const today = await propose('Lunch', '2026-01-01');
		const undated = await propose('Call grandma');

		expect(await k.runner.expirePassed()).toBe(1);
		expect(await statusOf(yesterday)).toBe('expired');
		expect(await statusOf(today)).toBe('pending');
		expect(await statusOf(undated)).toBe('pending');

		const before = await k.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.selectAll()
			.orderBy('id')
			.execute();
		k.clock.advance(60_000);
		expect(await k.runner.expirePassed()).toBe(0);
		const after = await k.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.selectAll()
			.orderBy('id')
			.execute();
		expect(after).toEqual(before);
		expect(await listed('pending')).toHaveLength(2);
	});

	it('expire shortly after midnight by the daily job, and today’s then passes too', async () => {
		const today = await propose('Lunch', '2026-01-01');
		await k.worker.drain();
		expect(await statusOf(today)).toBe('pending');
		// Just after midnight the day is over: the job the kernel planned at start runs.
		k.clock.advance(epochOf('2026-01-02', '00:06', 'UTC') - k.clock.now());
		await k.worker.drain();
		expect(await statusOf(today)).toBe('expired');
		expect(await waiting()).toBe(0);
	});

	it('never run: approving one is refused and nothing happens', async () => {
		const yesterday = await propose('Dinner', '2025-12-31');
		const error = await k.runner.approveDraft(yesterday, admin.actor).catch((e: unknown) => e);
		expect((error as FamosError).code).toBe('conflict');
		expect(runs).toBe(0);
		await k.runner.expirePassed();
		const again = await k.runner.approveDraft(yesterday, admin.actor).catch((e: unknown) => e);
		expect((again as FamosError).code).toBe('conflict');
		expect(runs).toBe(0);
	});

	it('can still be approved when an edit moves it to a day still ahead', async () => {
		const yesterday = await propose('Dinner', '2025-12-31');
		await k.runner.approveDraft(yesterday, admin.actor, { title: 'Dinner', day: '2026-01-03' });
		expect(await statusOf(yesterday)).toBe('applied');
		expect(runs).toBe(1);
	});
});

describe('the day a suggestion is about, for the words that tell of it', () => {
	const late = defineAction({
		id: 'plans.addTodo',
		title: 'Add a to-do',
		input: z.object({ title: z.string(), due: z.string().optional() }),
		output: z.object({ ok: z.literal(true) }),
		approval: { unless: planEdit.id },
		// A to-do that is late is still worth doing: no expiry, but its day is said.
		saidDate: (input) => input.due,
		async run() {
			return { ok: true as const };
		},
	});

	it('comes back with a drafted result: the action draftDate, or its saidDate', async () => {
		const both = defineTestExtension({
			id: 'plans',
			actions: [addPlan, late],
			capabilities: [planEdit],
		});
		await k.close();
		k = await createTestKernel({ extensions: [both] });
		const draft = { sourceKind: 'inbox', sourceId: 'item_a' };
		const invoke = (id: string, input: Record<string, unknown>) =>
			k.runner.invoke(id, input, AI, { draft });
		expect(await invoke('plans.addPlan', { title: 'Dinner', day: '2026-10-22' })).toMatchObject({
			status: 'drafted',
			date: '2026-10-22',
		});
		expect(await invoke('plans.addTodo', { title: 'Pack', due: '2025-12-01' })).toMatchObject({
			status: 'drafted',
			date: '2025-12-01',
		});
		expect(await invoke('plans.addTodo', { title: 'Call' })).not.toHaveProperty('date');
		expect(await invoke('plans.addPlan', { title: 'Lunch', day: 'Saturday' })).not.toHaveProperty(
			'date',
		);
	});
});
