import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lists from '../src/server/index.ts';
import { tables } from '../src/server/store.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-19', '10:00', TZ));
	admin = await k.member('admin', 'Ayse');
});
afterEach(() => k.close());

async function bins(): Promise<string> {
	const made = await k.runner.invoke<{ id: string }>(
		'lists.addTask',
		{
			title: 'Take out the bins',
			dueDate: '2026-10-20',
			recurrence: { freq: 'weekly', byDay: ['TU'] },
		},
		admin.actor,
	);
	if (made.status !== 'applied') throw new Error('expected a task');
	return made.output.id;
}

const row = (id: string) =>
	tables(k.ctx.db)
		.selectFrom('lists_tasks')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirstOrThrow();

/** The form as it saves: every field, null for one left empty. */
const form = (over: Record<string, unknown>) => ({
	title: 'Take out the bins',
	assigneeId: null,
	dueDate: '2026-10-20',
	dueTime: null,
	recurrence: { freq: 'weekly', interval: 1, byDay: ['TU'] },
	notes: null,
	...over,
});

const save = (id: string, task: Record<string, unknown>, keepRule?: boolean) =>
	k.runner.invoke('lists.updateTask', { id, task, ...(keepRule && { keepRule }) }, admin.actor);

describe('saving a whole repeating task', () => {
	it('keeps a repeat rule outside the presets through a form save', async () => {
		const id = await bins();
		const rule = 'FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-1';
		await tables(k.ctx.db)
			.updateTable('lists_tasks')
			.set({ rrule: rule })
			.where('id', '=', id)
			.execute();
		await save(id, form({ title: 'Bins out', recurrence: null }), true);
		const saved = await row(id);
		expect(saved.rrule).toBe(rule);
		expect(saved.rrule_start).toBe('2026-10-20');
		expect(saved.title).toBe('Bins out');
	});

	it('stops a custom repeat when the person chose "Does not repeat"', async () => {
		const id = await bins();
		await tables(k.ctx.db)
			.updateTable('lists_tasks')
			.set({ rrule: 'FREQ=MONTHLY;BYDAY=TU;BYSETPOS=-1' })
			.where('id', '=', id)
			.execute();
		await save(id, form({ recurrence: null }));
		const saved = await row(id);
		expect(saved.rrule).toBeNull();
		expect(saved.rrule_start).toBeNull();
	});

	it('keeps the day a repeat counts from while the rule and the due date stay', async () => {
		const id = await bins();
		await tables(k.ctx.db)
			.updateTable('lists_tasks')
			.set({ rrule_start: '2026-09-01' })
			.where('id', '=', id)
			.execute();
		await save(id, form({ title: 'Bins out' }));
		expect((await row(id)).rrule_start).toBe('2026-09-01');
		await save(id, form({ dueDate: '2026-10-27' }));
		expect((await row(id)).rrule_start).toBe('2026-10-27');
	});
});
