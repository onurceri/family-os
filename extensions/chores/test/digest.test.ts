import { type Actor, type DigestOutput, type MemberId, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { choreTurns } from '../src/server/digest.ts';
import chores from '../src/server/index.ts';

// The test clock stands at Thursday 1 January 2026, in UTC.
let k: TestKernel;
let mara: Awaited<ReturnType<TestKernel['member']>>;
let leo: Awaited<ReturnType<TestKernel['member']>>;
let ivy: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [chores] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: 'UTC' }, systemActor('test'));
	mara = await k.member('admin');
	leo = await k.member('supervised');
	ivy = await k.member('member');
});
afterEach(() => k.close());

const ai = (m = mara, roleId = 'admin'): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: m.member.id as MemberId,
	roleId,
});
const chore = (input: Record<string, unknown>) =>
	k.runner.invoke('chores.createChore', input, mara.actor);
const digest = async (input: Record<string, unknown>, actor: Actor = ai()) => {
	const result = await k.runner.invoke<DigestOutput>('chores.digest', input, actor);
	if (result.status !== 'applied') throw new Error('expected a read');
	return result.output;
};

describe('choreTurns', () => {
	const weekly = {
		recurrence: { freq: 'weekly' as const, interval: 1, byDay: ['MO' as const] },
		startDate: '2026-01-05',
		assigneeIds: ['a', 'b', 'c'],
	};

	it('names whose turn each one is, round robin', () => {
		const turns = choreTurns(
			{ ...weekly, nextDue: '2026-01-05', rotation: 'round_robin', assigneeId: 'b' },
			'2026-01-01',
			'2026-01-26',
			'2026-01-01',
		);
		expect(turns).toEqual([
			{ date: '2026-01-05', people: ['b'], overdue: false },
			{ date: '2026-01-12', people: ['c'], overdue: false },
			{ date: '2026-01-19', people: ['a'], overdue: false },
			{ date: '2026-01-26', people: ['b'], overdue: false },
		]);
	});

	it('keeps the same person when fixed, and names everyone in turn for least done', () => {
		const base = { ...weekly, nextDue: '2026-01-05', assigneeId: 'b' };
		const fixed = choreTurns(
			{ ...base, rotation: 'fixed' },
			'2026-01-01',
			'2026-01-12',
			'2026-01-01',
		);
		expect(fixed.map((t) => t.people)).toEqual([['b'], ['b']]);
		const least = choreTurns(
			{ ...base, rotation: 'least_done' },
			'2026-01-01',
			'2026-01-12',
			'2026-01-01',
		);
		expect(least.map((t) => t.people)).toEqual([['b'], ['a', 'b', 'c']]);
	});

	it('counts a late turn on its day when the span holds today, then skips the missed ones', () => {
		const late = { ...weekly, nextDue: '2025-12-22', rotation: 'fixed' as const, assigneeId: 'a' };
		expect(choreTurns(late, '2026-01-01', '2026-01-12', '2026-01-01')).toEqual([
			{ date: '2025-12-22', people: ['a'], overdue: true },
			{ date: '2026-01-05', people: ['a'], overdue: false },
			{ date: '2026-01-12', people: ['a'], overdue: false },
		]);
		expect(choreTurns(late, '2026-01-06', '2026-01-12', '2026-01-01')).toEqual([
			{ date: '2026-01-12', people: ['a'], overdue: false },
		]);
	});

	it('has nothing for a one-off chore that is done', () => {
		expect(
			choreTurns(
				{ ...weekly, recurrence: null, nextDue: null, rotation: 'fixed', assigneeId: null },
				'2026-01-01',
				'2026-01-31',
				'2026-01-01',
			),
		).toEqual([]);
	});
});

describe('chores.digest', () => {
	it('holds the turns in the span with whose they are and their notes', async () => {
		await chore({
			title: 'Bins out',
			notes: 'Green bin on odd weeks',
			startDate: '2026-01-05',
			recurrence: { freq: 'weekly', byDay: ['MO'] },
			rotation: 'round_robin',
			assigneeIds: [leo.member.id, ivy.member.id],
		});
		await chore({ title: 'Clean the oven', startDate: '2026-01-20' });
		const out = await digest({ from: '2026-01-05', to: '2026-01-18' });
		expect(out.items.map((i) => [i.date, i.title, i.people])).toEqual([
			['2026-01-05', 'Bins out', [leo.member.id]],
			['2026-01-12', 'Bins out', [ivy.member.id]],
		]);
		expect(out.items[0]).toMatchObject({
			kind: 'chore',
			notes: 'Green bin on odd weeks',
			extra: { repeats: 'yes' },
		});
		expect(out.nextAfter).toBeUndefined();
	});

	it('keeps the turns of the people asked about and the ones anyone may take', async () => {
		await chore({
			title: 'Bins out',
			startDate: '2026-01-05',
			recurrence: { freq: 'weekly', byDay: ['MO'] },
			rotation: 'round_robin',
			assigneeIds: [leo.member.id, ivy.member.id],
		});
		await chore({ title: 'Anyone dusts', startDate: '2026-01-06' });
		const out = await digest({
			from: '2026-01-05',
			to: '2026-01-18',
			memberIds: [ivy.member.id],
		});
		expect(out.items.map((i) => `${i.date} ${i.title}`)).toEqual([
			'2026-01-06 Anyone dusts',
			'2026-01-12 Bins out',
		]);
	});

	it('ranks by the words asked about and keeps every turn', async () => {
		await chore({ title: 'Dishes', startDate: '2026-01-02' });
		await chore({ title: 'Walk the dog', startDate: '2026-01-02' });
		const out = await digest({ from: '2026-01-02', to: '2026-01-02', about: ['dog'] });
		expect(out.items.map((i) => i.title)).toEqual(['Walk the dog', 'Dishes']);
	});

	it('marks a late turn when the span holds today, and says what comes next when empty', async () => {
		await chore({ title: 'Defrost the freezer', startDate: '2025-12-20' });
		const now = await digest({ from: '2026-01-01', to: '2026-01-07' });
		expect(now.items).toMatchObject([{ date: '2025-12-20', status: 'overdue' }]);
		await chore({ title: 'Sweep the chimney', startDate: '2026-05-01' });
		const later = await digest({ from: '2026-01-10', to: '2026-01-11' });
		expect(later.items).toEqual([]);
		expect(later.nextAfter).toMatchObject({ title: 'Sweep the chimney', date: '2026-05-01' });
	});

	it('cuts a crowded span and says so', async () => {
		await chore({ title: 'Feed the cat', startDate: '2026-01-01', recurrence: { freq: 'daily' } });
		await chore({ title: 'Water plants', startDate: '2026-01-01', recurrence: { freq: 'daily' } });
		const out = await digest({ from: '2026-01-01', to: '2026-01-31' });
		expect(out.items).toHaveLength(60);
		expect(out.truncated).toBe(true);
	});

	it('gives nothing to an AI whose area is off', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'chores', access: 'off' },
			mara.actor,
		);
		await expect(
			k.runner.invoke('chores.digest', { from: '2026-01-01', to: '2026-01-07' }, ai()),
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});
