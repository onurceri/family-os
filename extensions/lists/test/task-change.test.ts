import { type Actor, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf, todayIn } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lists from '../src/server/index.ts';
import { dueLabel } from '../src/web/format.ts';
import { changeTaskFields, updateTaskFields } from '../src/web/task-change.ts';

// A change card reads "old → new": the server sends what the fields it changes hold now.
const TZ = 'Europe/Istanbul';
const AI: Actor = { kind: 'ai', mode: 'conversation', source: 'assistant' };
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [lists] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-12', '10:00', TZ));
	admin = await k.member('admin', 'Ayse');
});
afterEach(() => k.close());

type Listed = { id: string; before: Record<string, unknown> | null };
const listed = async (id: string) =>
	(
		(await k
			.route('core.listDrafts')
			.call({ actor: admin.actor, query: { limit: 20 } })) as Listed[]
	).find((d) => d.id === id) as Listed;

describe('a suggested change to a task', () => {
	it('comes with the task as it is, and the card reads old → new', async () => {
		const made = await k.runner.invoke<{ id: string }>(
			'lists.addTask',
			{ title: 'Pay the bills', dueDate: '2026-10-20', notes: 'Water' },
			admin.actor,
		);
		if (made.status !== 'applied') throw new Error('expected a task');
		const input = {
			id: made.output.id,
			label: 'Pay the bills',
			assigneeId: admin.member.id,
			dueDate: '2026-10-25',
		};
		const result = await k.runner.invoke('lists.changeTask', input, AI);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		const { before } = await listed(result.draftId);
		expect(before).toEqual({ assigneeId: null, dueDate: '2026-10-20', dueTime: null });

		const context = {
			t: (key: string) => key,
			members: [{ id: admin.member.id, displayName: 'Ayse', color: 'sky' }],
			formatLocale: 'en-GB',
			dateLocale: 'en-GB',
			weekStart: 1,
			hourCycle: 'h23' as const,
			timeZone: TZ,
		};
		const fields = changeTaskFields(input, context, before);
		expect(fields[0]?.value).toBe('lists:anyone → Ayse');
		// The deadline reads as the task list says it, relative to today.
		const today = todayIn(TZ, Date.now());
		const due = (dueDate: string) =>
			dueLabel({ dueDate, dueTime: null }, today, context.t as never, 'en-GB', 'h23');
		expect(fields[1]?.value).toBe(`${due('2026-10-20')} → ${due('2026-10-25')}`);
		// Without it, only the new values.
		expect(changeTaskFields(input, context, null)[0]?.value).toBe('Ayse');
	});
});

describe('an edit saved from the task form that needs approval', () => {
	it('names the task and lists only the new deadline, old → new', async () => {
		const made = await k.runner.invoke<{ id: string }>(
			'lists.addTask',
			{ title: 'Fractions worksheet', notes: 'Pages 4 and 5' },
			admin.actor,
		);
		if (made.status !== 'applied') throw new Error('expected a task');
		const ivy = await k.member('supervised', 'Ivy');
		// The form sends the whole task back with the one field the person changed.
		const task = { title: 'Fractions worksheet', notes: 'Pages 4 and 5', dueDate: '2026-10-20' };
		const result = await k.runner.invoke(
			'lists.updateTask',
			{ id: made.output.id, task },
			ivy.actor,
		);
		if (result.status !== 'drafted') throw new Error('expected a draft');
		expect(result).toMatchObject({ subject: 'Fractions worksheet' });
		const { before } = await listed(result.draftId);
		expect(before).toEqual({ dueDate: null, dueTime: null });
		const context = {
			t: (key: string) => key,
			members: [],
			formatLocale: 'en-GB',
			weekStart: 1,
			hourCycle: 'h23' as const,
			timeZone: TZ,
		};
		const fields = updateTaskFields(
			{ id: made.output.id, task },
			context,
			before as Record<string, unknown>,
		);
		const today = todayIn(TZ, Date.now());
		const due = dueLabel(
			{ dueDate: '2026-10-20', dueTime: null },
			today,
			context.t as never,
			'en-GB',
			'h23',
		);
		expect(fields.map((f) => f.value)).toEqual([`lists:no_due → ${due}`]);
	});
});
