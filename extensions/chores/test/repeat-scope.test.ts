import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chore, MarkDoneResult } from '../src/contract/index.ts';
import { applied, at, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;
let child: Person;

beforeEach(async () => {
	({ k } = await createKernel());
	k.clock.set(at('2026-10-19', '10:00'));
	admin = await person(k, 'admin', 'Ayse');
	child = await person(k, 'supervised', 'Elif');
});
afterEach(() => k.close());

// 2026-10-18 is a Sunday: "every Tuesday", started on a Sunday, is next due on Tuesday the 20th.
const bins = async () =>
	applied<Chore>(
		k,
		'chores.createChore',
		{
			title: 'Take out the bins',
			startDate: '2026-10-18',
			recurrence: { freq: 'weekly', interval: 1, byDay: ['TU'] },
			assigneeIds: [admin.id, child.id],
			rotation: 'round_robin',
		},
		admin.actor,
	);

const form = (over: Record<string, unknown>) => ({
	title: 'Take out the bins',
	notes: null,
	startDate: '2026-10-18',
	recurrence: { freq: 'weekly', interval: 1, byDay: ['TU'] },
	rotation: 'round_robin',
	...over,
});

const get = async (id: string): Promise<Chore> =>
	((await k.route('chores.listAllChores').call()) as Chore[]).find((c) => c.id === id) as Chore;

describe('changing the date of a saved repeating chore', () => {
	it('only this one moves this turn; the days stay and the next turn follows them', async () => {
		const chore = await bins();
		expect(chore.nextDue).toBe('2026-10-20');
		await applied(
			k,
			'chores.updateChore',
			{ id: chore.id, chore: form({}), onlyThisTurnOn: '2026-10-21' },
			admin.actor,
		);
		const moved = await get(chore.id);
		expect(moved).toMatchObject({ nextDue: '2026-10-21', startDate: '2026-10-18' });
		expect(moved.recurrence).toMatchObject({ freq: 'weekly', byDay: ['TU'] });
		const next = await applied<MarkDoneResult>(
			k,
			'chores.markDone',
			{ id: chore.id, dueDate: '2026-10-21' },
			admin.actor,
		);
		expect(next.chore.nextDue).toBe('2026-10-27');
		// The turn passed on as it would have.
		expect(next.chore.assigneeId).toBe(child.id);
	});

	it('this one and the ones after starts the repeat at the new date', async () => {
		const chore = await bins();
		await applied(
			k,
			'chores.updateChore',
			{ id: chore.id, chore: form({ startDate: '2026-10-21' }) },
			admin.actor,
		);
		expect(await get(chore.id)).toMatchObject({ startDate: '2026-10-21', nextDue: '2026-10-27' });
	});

	it('keeps whose turn it is when the repeat changes', async () => {
		const chore = await bins();
		await applied(k, 'chores.markDone', { id: chore.id, dueDate: '2026-10-20' }, admin.actor);
		const before = await get(chore.id);
		await applied(
			k,
			'chores.updateChore',
			{ id: chore.id, chore: form({ startDate: '2026-10-21' }) },
			admin.actor,
		);
		const after = await get(chore.id);
		expect(after.assigneeId).toBe(before.assigneeId);
	});

	it('a supervised member asks for it and it waits', async () => {
		const chore = await bins();
		const result = await k.runner.invoke(
			'chores.updateChore',
			{ id: chore.id, chore: form({}), onlyThisTurnOn: '2026-10-21' },
			child.actor,
		);
		expect(result.status).toBe('drafted');
		expect((await get(chore.id)).nextDue).toBe('2026-10-20');
	});
});
