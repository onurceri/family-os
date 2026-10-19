import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lists from '../src/server/index.ts';

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

type Task = { id: string; dueDate: string | null; recurrence: { byDay?: string[] } | null };
const tasks = () => k.route('lists.listTasks').call({ query: {} }) as Promise<Task[]>;
const find = async (id: string) => (await tasks()).find((t) => t.id === id) as Task;

// 2026-10-20 is a Tuesday: "every Tuesday", first due that day.
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

const form = (over: Record<string, unknown>) => ({
	title: 'Take out the bins',
	assigneeId: null,
	dueDate: '2026-10-20',
	dueTime: null,
	recurrence: { freq: 'weekly', interval: 1, byDay: ['TU'] },
	notes: null,
	...over,
});

describe('changing the date of a saved repeating task', () => {
	it('only this one moves this due date; the days stay and the next one follows them', async () => {
		const id = await bins();
		await k.runner.invoke(
			'lists.updateTask',
			{ id, task: form({ dueDate: '2026-10-21' }), onlyThisDate: '2026-10-21' },
			admin.actor,
		);
		expect(await find(id)).toMatchObject({
			dueDate: '2026-10-21',
			recurrence: { byDay: ['TU'] },
		});
		await k.runner.invoke('lists.completeTask', { id }, admin.actor);
		expect((await find(id)).dueDate).toBe('2026-10-27');
	});

	it('this one and the ones after starts the repeat at the new date and days', async () => {
		const id = await bins();
		await k.runner.invoke(
			'lists.updateTask',
			{
				id,
				task: form({
					dueDate: '2026-10-21',
					recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'] },
				}),
			},
			admin.actor,
		);
		expect(await find(id)).toMatchObject({ dueDate: '2026-10-21', recurrence: { byDay: ['WE'] } });
		await k.runner.invoke('lists.completeTask', { id }, admin.actor);
		expect((await find(id)).dueDate).toBe('2026-10-28');
	});

	it('a supervised member asks for it and it waits', async () => {
		const id = await bins();
		const child = await k.member('supervised', 'Leo');
		const result = await k.runner.invoke(
			'lists.updateTask',
			{ id, task: form({ dueDate: '2026-10-21' }), onlyThisDate: '2026-10-21' },
			child.actor,
		);
		expect(result.status).toBe('drafted');
		expect((await find(id)).dueDate).toBe('2026-10-20');
	});
});
