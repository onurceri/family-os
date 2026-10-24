import { type Actor, systemActor } from '@famos/sdk';
import { createFakeChannel, createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lists from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let channel: ReturnType<typeof createFakeChannel>;

beforeEach(async () => {
	channel = createFakeChannel('web');
	k = await createTestKernel({
		extensions: [lists],
		channels: [channel],
		translate: (locale, key, params) => `${locale}|${key}|${JSON.stringify(params ?? {})}`,
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, formatLocale: 'en-GB', hourCycle: 'h23' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
});
afterEach(() => k.close());

const at = (date: string, time: string) => epochOf(date, time, TZ);

async function person(roleId: string, locale: 'en' | 'tr') {
	const result = await k.runner.invoke<{ id: string }>(
		'core.createMember',
		{ displayName: `${roleId} ${locale}`, roleId, locale },
		systemActor('test'),
	);
	if (result.status !== 'applied') throw new Error('expected member');
	const actor: Actor = { kind: 'member', memberId: result.output.id as never, roleId };
	return { id: result.output.id, actor };
}

async function addTask(input: Record<string, unknown>, actor: Actor) {
	const r = await k.runner.invoke<{ id: string }>('lists.addTask', input, actor);
	if (r.status !== 'applied') throw new Error('expected applied');
	return r.output.id;
}

async function advanceTo(ms: number) {
	k.clock.set(ms);
	await k.worker.drain();
}
const reminders = () => channel.sent.filter((s) => s.message.title.includes('task_due_title'));

describe('task reminders', () => {
	it('reminds the assignee at the due time, in their language', async () => {
		const ann = await person('admin', 'tr');
		const bob = await person('member', 'en');
		await addTask(
			{ title: 'Pay the fee', assigneeId: ann.id, dueDate: '2026-10-09', dueTime: '15:30' },
			ann.actor,
		);
		await advanceTo(at('2026-10-09', '15:30') - 1);
		expect(reminders()).toHaveLength(0);
		await advanceTo(at('2026-10-09', '15:30'));
		expect(reminders()).toHaveLength(1);
		expect(reminders()[0]).toMatchObject({
			memberId: ann.id,
			message: {
				title: 'tr|lists:task_due_title|{"title":"Pay the fee"}',
				body: 'tr|lists:task_due_at|{"time":"15:30"}',
				url: '/lists/tasks',
			},
		});
		expect(reminders().some((s) => s.memberId === bob.id)).toBe(false);
	});

	it('writes the reminder time in the family hour cycle', async () => {
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ formatLocale: 'en-US', hourCycle: 'h12' },
			systemActor('test'),
		);
		const ann = await person('admin', 'en');
		await addTask(
			{ title: 'Pay the fee', assigneeId: ann.id, dueDate: '2026-10-09', dueTime: '15:30' },
			ann.actor,
		);
		await advanceTo(at('2026-10-09', '15:30'));
		const body = reminders()[0]?.message.body?.replace(/[\u202f\u00a0]/g, ' ');
		expect(body).toContain('"time":"3:30 PM"');
	});

	it('uses 09:00 when there is no time, and reminds everyone who can see lists when unassigned', async () => {
		const ann = await person('admin', 'en');
		const bob = await person('member', 'en');
		await addTask({ title: 'Take out the bins', dueDate: '2026-10-08' }, ann.actor);
		await advanceTo(at('2026-10-08', '09:00') - 1);
		expect(reminders()).toHaveLength(0);
		await advanceTo(at('2026-10-08', '09:00'));
		const who = reminders().map((s) => s.memberId);
		expect(who).toEqual(expect.arrayContaining([ann.id, bob.id]));
		expect(reminders()[0]?.message.body).toBe('en|lists:task_due_today|{}');
	});

	it('uses the family reminder time when there is no time, and the task time when there is one', async () => {
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ reminderTime: '07:30' },
			systemActor('test'),
		);
		const ann = await person('admin', 'en');
		await addTask({ title: 'Bins', assigneeId: ann.id, dueDate: '2026-10-08' }, ann.actor);
		await addTask(
			{ title: 'Fee', assigneeId: ann.id, dueDate: '2026-10-08', dueTime: '15:30' },
			ann.actor,
		);
		await advanceTo(at('2026-10-08', '07:29'));
		expect(reminders()).toHaveLength(0);
		await advanceTo(at('2026-10-08', '07:30'));
		expect(reminders().map((s) => s.message.body)).toEqual(['en|lists:task_due_today|{}']);
		await advanceTo(at('2026-10-08', '15:30'));
		expect(reminders()).toHaveLength(2);
	});

	it('waits for a reminder time moved later after the reminder was planned', async () => {
		const ann = await person('admin', 'en');
		await addTask({ title: 'Bins', assigneeId: ann.id, dueDate: '2026-10-08' }, ann.actor);
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ reminderTime: '11:00' },
			systemActor('test'),
		);
		await advanceTo(at('2026-10-08', '09:00'));
		expect(reminders()).toHaveLength(0);
		await advanceTo(at('2026-10-08', '11:00'));
		expect(reminders()).toHaveLength(1);
		await advanceTo(at('2026-10-08', '14:00'));
		expect(reminders()).toHaveLength(1);
	});

	it('sends nothing for a task completed or deleted first, or without a due date', async () => {
		const ann = await person('admin', 'en');
		const done = await addTask(
			{ title: 'Done', assigneeId: ann.id, dueDate: '2026-10-08' },
			ann.actor,
		);
		const gone = await addTask(
			{ title: 'Gone', assigneeId: ann.id, dueDate: '2026-10-08' },
			ann.actor,
		);
		await addTask({ title: 'Someday', assigneeId: ann.id }, ann.actor);
		await k.runner.invoke('lists.completeTask', { id: done }, ann.actor);
		await k.runner.invoke('lists.deleteTask', { id: gone }, ann.actor);
		await advanceTo(at('2026-10-08', '12:00'));
		expect(reminders()).toHaveLength(0);
	});

	it('follows a changed due date', async () => {
		const ann = await person('admin', 'en');
		const id = await addTask(
			{ title: 'Form', assigneeId: ann.id, dueDate: '2026-10-08' },
			ann.actor,
		);
		await k.runner.invoke(
			'lists.updateTask',
			{
				id,
				task: {
					title: 'Form',
					assigneeId: ann.id,
					dueDate: '2026-10-10',
					dueTime: '12:00',
					recurrence: null,
					notes: null,
				},
			},
			ann.actor,
		);
		await advanceTo(at('2026-10-08', '09:30'));
		expect(reminders()).toHaveLength(0);
		await advanceTo(at('2026-10-10', '12:00'));
		expect(reminders()).toHaveLength(1);
	});

	it('plans the next due date of a repeating task when it is completed', async () => {
		const ann = await person('admin', 'en');
		const id = await addTask(
			{
				title: 'Water the plants',
				assigneeId: ann.id,
				dueDate: '2026-10-07',
				recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'] },
			},
			ann.actor,
		);
		await advanceTo(at('2026-10-07', '09:00'));
		expect(reminders()).toHaveLength(1);
		await k.runner.invoke('lists.completeTask', { id }, ann.actor);
		await advanceTo(at('2026-10-14', '09:00') - 1);
		expect(reminders()).toHaveLength(1);
		await advanceTo(at('2026-10-14', '09:00'));
		expect(reminders()).toHaveLength(2);
	});

	it('does not remind a second time for the same due date when the job runs again', async () => {
		const ann = await person('admin', 'en');
		const id = await addTask(
			{ title: 'Form', assigneeId: ann.id, dueDate: '2026-10-08' },
			ann.actor,
		);
		await advanceTo(at('2026-10-08', '09:00'));
		expect(reminders()).toHaveLength(1);
		const payload = { taskId: id, dueDate: '2026-10-08', dueTime: null, version: 0 };
		const row = await k.ctx.db
			.withTables<{ lists_tasks: { id: string; updated_at: number } }>()
			.selectFrom('lists_tasks')
			.select('updated_at')
			.where('id', '=', id)
			.executeTakeFirstOrThrow();
		await k.queue.enqueue(k.ctx.db, 'lists.remind', { ...payload, version: row.updated_at });
		await advanceTo(at('2026-10-08', '09:05'));
		expect(reminders()).toHaveLength(1);
	});
});
