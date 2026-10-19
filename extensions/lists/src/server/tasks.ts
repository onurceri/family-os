import {
	type Actor,
	type DuplicateContext,
	defineAction,
	defineCapability,
	defineEvent,
	defineRoute,
	digestNotes,
	FamosError,
	namesThing,
	storedAsWhole,
	type UnitOfWork,
} from '@famos/sdk';
import { formatDate, IsoDateSchema, IsoTimeSchema, nextDate, todayIn, toRRule } from '@famos/time';
import { sql } from 'kysely';
import { z } from 'zod';
import {
	MemberIdSchema,
	ReviewLabelSchema,
	TASK_TITLE_MAX,
	TaskIdSchema,
	TaskInputSchema,
	TaskReplaceSchema,
	TaskSchema,
	taskChangedPayload,
} from '../contract/index.ts';
import { scheduleTaskReminder } from './reminders.ts';
import { tables, titleKey, toTask } from './store.ts';

export const taskChanged = defineEvent('lists.task.changed', taskChangedPayload, {
	audience: 'lists.view',
});

/** What tasks protect. */
export const listsView = defineCapability({
	id: 'lists.view',
	label: 'lists:cap_view',
	level: 'view',
});
export const tasksEdit = defineCapability({
	id: 'lists.tasks.edit',
	label: 'lists:cap_tasks_edit',
	level: 'edit',
});
export const tasksComplete = defineCapability({
	id: 'lists.tasks.complete',
	label: 'lists:cap_tasks_complete',
	level: 'use',
});
const memberId = (actor: Actor) => (actor.kind === 'member' ? actor.memberId : null);

async function assertMember(uow: UnitOfWork, id: string | null | undefined) {
	if (!id) return;
	const active = await uow.family.members();
	if (!active.some((m) => m.id === id))
		throw new FamosError('bad_request', `Unknown member: ${id}`);
}

/** Plans the reminder for a task as it is now (after an insert, edit, completion or reopen). */
async function scheduleReminder(uow: UnitOfWork, id: string) {
	const row = await load(uow, id);
	const { timeZone } = await uow.family.settings();
	await scheduleTaskReminder(
		(job, payload, o) => uow.enqueue(job, payload, o),
		row,
		uow.clock.now(),
		timeZone,
	);
}

/** The title of an open task, for the runner's check that an AI's label names the right one. */
const taskTitle = async (ctx: DuplicateContext, { id }: { id: string }) =>
	(
		await tables(ctx.db)
			.selectFrom('lists_tasks')
			.select('title')
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst()
	)?.title ?? null;

/**
 * A task is a person's own when they made it for themselves (created by them and theirs to do);
 * they may change or delete it without anyone's approval as long as it stays theirs: giving it to
 * someone else, or to anyone, is the same as adding a task for others. Deleted tasks count too,
 * so a deletion can be taken back.
 */
async function ownTaskOf(
	ctx: DuplicateContext,
	id: string,
	assigneeId?: string | null,
): Promise<string | null> {
	const row = await tables(ctx.db)
		.selectFrom('lists_tasks')
		.select(['created_by', 'assignee_id'])
		.where('id', '=', id)
		.executeTakeFirst();
	if (!row?.created_by) return null;
	const assignee = assigneeId === undefined ? row.assignee_id : assigneeId;
	return assignee === row.created_by ? row.created_by : null;
}

async function load(uow: UnitOfWork, id: string) {
	const row = await tables(uow.db)
		.selectFrom('lists_tasks')
		.selectAll()
		.where('id', '=', id)
		.where('deleted_at', 'is', null)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Task not found');
	return row;
}

function fields(input: z.infer<typeof TaskInputSchema>) {
	const dueDate = input.dueDate ?? null;
	return {
		title: input.title,
		notes: input.notes ?? null,
		assignee_id: input.assigneeId ?? null,
		due_date: dueDate,
		due_time: dueDate ? (input.dueTime ?? null) : null,
		rrule: input.recurrence ? toRRule(input.recurrence, null) : null,
		rrule_start: input.recurrence ? dueDate : null,
	};
}

export const addTask = defineAction({
	id: 'lists.addTask',
	title: 'Add a task',
	draftTitle: 'lists:draft_title_add_task',
	autoApprove: { label: 'lists:auto_approve_tasks', capabilities: [tasksEdit.id] },
	input: TaskInputSchema,
	output: TaskSchema,
	// A task that is late is still worth doing, so the suggestion never expires; it says its day.
	saidDate: (input) => input.dueDate ?? undefined,
	// Anyone who may propose can add a task for themselves directly; tasks for others need the capability.
	approval: {
		unless: tasksEdit.id,
		except: (actor, input) => actor.kind === 'member' && input.assigneeId === actor.memberId,
	},
	undo: (task) => ({ actionId: 'lists.deleteTask', input: { id: task.id } }),
	// A task that says the same: the same words of the title (a longer or shorter way of saying it
	// counts), whatever its due date, while it is still open; a done one only on the same due date,
	// since one that was ticked off the same day it was suggested again is still the same piece of
	// work.
	async alreadyThere(ctx, input) {
		const { locale } = await ctx.family.settings();
		const rows = await tables(ctx.db)
			.selectFrom('lists_tasks')
			.select(['title', 'due_date', 'done_at'])
			.where('deleted_at', 'is', null)
			.execute();
		const key = titleKey(input.title, locale);
		const due = input.dueDate ?? null;
		return rows.some(
			(row) =>
				(row.due_date === due && titleKey(row.title, locale) === key) ||
				((row.done_at === null || row.due_date === due) &&
					namesThing(input.title, row.title, { language: locale })),
		);
	},
	ai: {
		description:
			'Adds a to-do for the family: something a person must do, often by a deadline (pay a fee, sign and return a form, buy a gift, call someone). Use the calendar instead for things that happen at a set time.',
		guidance:
			'Resolve relative deadlines ("by Thursday") from today\'s date in the family time zone. Assign the member who must act when it is clear (for payments and forms usually an adult, judging from the members\' descriptions); otherwise leave it unassigned. Use recurrence only for chores the text says repeat.',
	},
	async run(uow, input) {
		await assertMember(uow, input.assigneeId);
		const now = uow.clock.now();
		const row = {
			id: uow.ids.next('task'),
			...fields(input),
			done_at: null,
			done_by: null,
			created_by: memberId(uow.actor),
			source_kind: null,
			source_id: null,
			created_at: now,
			updated_at: now,
			deleted_at: null,
		};
		await tables(uow.db).insertInto('lists_tasks').values(row).execute();
		await scheduleReminder(uow, row.id);
		uow.emit(taskChanged, { taskId: row.id });
		return toTask(row);
	},
});

export const updateTask = defineAction({
	id: 'lists.updateTask',
	target: ({ id }) => ({ table: 'lists_tasks', id, liveColumn: 'deleted_at' }),
	title: 'Change a task',
	description:
		'Replaces the whole task with what the form saved: send every field, null for one left empty. To change some fields and keep the rest, use lists.changeTask.',
	draftTitle: 'lists:draft_title_update_task',
	input: z.object({
		id: TaskIdSchema,
		task: TaskReplaceSchema,
		onlyThisDate: IsoDateSchema.optional().describe(
			'Repeating tasks: moves only the due date now up to this day (YYYY-MM-DD); the repeat and its start stay as they are. Leave out to change the task from now on',
		),
	}),
	// Waiting from when a field left out meant empty (or its default): read that way.
	storedInput: storedAsWhole(TaskInputSchema, 'task'),
	output: TaskSchema,
	saidDate: ({ task }) => task.dueDate ?? undefined,
	approval: {
		unless: tasksEdit.id,
		owner: (ctx, { id, task }) => ownTaskOf(ctx, id, task.assigneeId ?? null),
	},
	targetTitle: taskTitle,
	// The form sends the whole task: what differs from the task as it is now is what changes, so
	// the card lists only those fields, "old → new" (a deadline is its date and time together).
	async currentValues(ctx, { id, task }) {
		const row = await tables(ctx.db)
			.selectFrom('lists_tasks')
			.selectAll()
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		if (!row) return null;
		const next = fields(task);
		const keys: string[] = [];
		if (row.title !== next.title) keys.push('title');
		if (row.assignee_id !== next.assignee_id) keys.push('assigneeId');
		if (row.due_date !== next.due_date || row.due_time !== next.due_time)
			keys.push('dueDate', 'dueTime');
		if ((row.notes ?? null) !== next.notes) keys.push('notes');
		if (row.rrule !== next.rrule) keys.push('recurrence');
		const values: Record<string, unknown> = {
			title: row.title,
			assigneeId: row.assignee_id,
			dueDate: row.due_date,
			dueTime: row.due_time,
			notes: row.notes,
			recurrence: toTask(row).recurrence,
		};
		return Object.fromEntries(keys.map((k) => [k, values[k] ?? null]));
	},
	async run(uow, { id, task, onlyThisDate }) {
		const row = await load(uow, id);
		await assertMember(uow, task.assigneeId);
		// Only this one: the due date moves, the repeat and its start stay as they are.
		const { rrule: _rule, rrule_start: _start, ...details } = fields(task);
		const patch =
			onlyThisDate && row.rrule
				? { ...details, due_date: onlyThisDate, due_time: task.dueTime ?? null }
				: fields(task);
		await tables(uow.db)
			.updateTable('lists_tasks')
			.set({ ...patch, updated_at: uow.clock.now() })
			.where('id', '=', id)
			.execute();
		await scheduleReminder(uow, id);
		uow.emit(taskChanged, { taskId: id });
		return toTask(await load(uow, id));
	},
});

/** The fields a change may touch; each one left out stays as it is. */
const TaskChangeSchema = z.object({
	title: z.string().trim().min(1).max(TASK_TITLE_MAX).optional().describe('The new title'),
	assigneeId: MemberIdSchema.nullable()
		.optional()
		.describe('The member who should do it; null means anyone'),
	dueDate: IsoDateSchema.nullable()
		.optional()
		.describe('New deadline, YYYY-MM-DD, in the family time zone; null removes it'),
	dueTime: IsoTimeSchema.nullable().optional().describe('New deadline time HH:MM; null removes it'),
	notes: z.string().trim().max(2000).nullable().optional().describe('New notes; null clears them'),
});

/**
 * Changes some fields of a task and keeps the rest (the AI and agents send only what changes,
 * so a repeat rule or notes they never saw are not lost). The output carries the old values,
 * so the change can be taken back.
 */
export const changeTask = defineAction({
	id: 'lists.changeTask',
	target: ({ id }) => ({ table: 'lists_tasks', id, liveColumn: 'deleted_at' }),
	targetTitle: taskTitle,
	title: 'Change some details of a task',
	draftTitle: 'lists:draft_title_change_task',
	input: TaskChangeSchema.extend({ id: TaskIdSchema, label: ReviewLabelSchema }),
	// The old values of what changed, keyed like the input (for undo).
	output: z.object({ task: TaskSchema, before: z.record(z.string(), z.string().nullable()) }),
	approval: {
		unless: tasksEdit.id,
		owner: (ctx, { id, assigneeId }) => ownTaskOf(ctx, id, assigneeId),
	},
	undo: ({ task, before }) => ({ actionId: 'lists.changeTask', input: { id: task.id, ...before } }),
	// The task as it is now, for the card's "old → new"; a deadline is its date and time together.
	async currentValues(ctx, { id, label: _label, ...change }) {
		const row = await tables(ctx.db)
			.selectFrom('lists_tasks')
			.selectAll()
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		if (!row) return null;
		const values: Record<string, unknown> = {
			title: row.title,
			assigneeId: row.assignee_id,
			dueDate: row.due_date,
			dueTime: row.due_time,
			notes: row.notes,
		};
		const changed = Object.keys(change).filter(
			(k) => change[k as keyof typeof change] !== undefined,
		);
		const due = changed.includes('dueDate') || changed.includes('dueTime');
		const keys = new Set([...changed, ...(due ? ['dueDate', 'dueTime'] : [])]);
		return Object.fromEntries([...keys].map((k) => [k, values[k] ?? null]));
	},
	ai: {
		description:
			'Changes an existing open task: who does it, its deadline, its title or notes. Send only the fields that change. Find the task with lists.openTasks first; never add a second task for the same thing.',
		guidance:
			"Resolve relative deadlines from today's date in the family time zone. To make a task anyone's again, send assigneeId null.",
	},
	async run(uow, { id, label: _label, ...change }) {
		const row = await load(uow, id);
		await assertMember(uow, change.assigneeId);
		const dueDate = change.dueDate !== undefined ? change.dueDate : row.due_date;
		const dueTime = change.dueTime !== undefined ? change.dueTime : row.due_time;
		if (dueTime && !dueDate) throw new FamosError('bad_request', 'A due time needs a due date');
		if (row.rrule && !dueDate)
			throw new FamosError('bad_request', 'A repeating task needs a due date');
		const before: Record<string, string | null> = {};
		const patch: Partial<typeof row> = {};
		if (change.title !== undefined) {
			before.title = row.title;
			patch.title = change.title;
		}
		if (change.assigneeId !== undefined) {
			before.assigneeId = row.assignee_id;
			patch.assignee_id = change.assigneeId;
		}
		if (change.dueDate !== undefined) {
			before.dueDate = row.due_date;
			patch.due_date = change.dueDate;
			// A repeating task restarts its rule from the new date.
			if (row.rrule) patch.rrule_start = change.dueDate;
		}
		if (change.dueTime !== undefined || (change.dueDate === null && row.due_time)) {
			before.dueTime = row.due_time;
			patch.due_time = dueDate ? (dueTime ?? null) : null;
		}
		if (change.notes !== undefined) {
			before.notes = row.notes;
			patch.notes = change.notes;
		}
		if (Object.keys(patch).length === 0) return { task: toTask(row), before };
		await tables(uow.db)
			.updateTable('lists_tasks')
			.set({ ...patch, updated_at: uow.clock.now() })
			.where('id', '=', id)
			.execute();
		await scheduleReminder(uow, id);
		uow.emit(taskChanged, { taskId: id });
		return { task: toTask(await load(uow, id)), before };
	},
});

export const completeTask = defineAction({
	id: 'lists.completeTask',
	target: ({ id }) => ({ table: 'lists_tasks', id, liveColumn: 'deleted_at' }),
	targetTitle: taskTitle,
	offline: true,
	title: 'Mark a task done',
	draftTitle: 'lists:draft_title_complete_task',
	description: 'A repeating task moves on to its next due date instead.',
	input: z.object({
		id: TaskIdSchema,
		label: ReviewLabelSchema,
		/** The due date the caller saw; a stale completion (already rolled forward) is ignored. */
		dueDate: IsoDateSchema.nullable().optional(),
	}),
	output: TaskSchema,
	requires: tasksComplete.id,
	approval: 'ai',
	// Done already, or its due date moved on: running it would change nothing, and its undo
	// would reopen a completion somebody else made.
	async settled(ctx, { id, dueDate }) {
		const row = await tables(ctx.db)
			.selectFrom('lists_tasks')
			.select(['done_at', 'due_date'])
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		return (
			row !== undefined &&
			(row.done_at !== null || (dueDate !== undefined && dueDate !== row.due_date))
		);
	},
	undo: (task) => ({ actionId: 'lists.reopenTask', input: { id: task.id } }),
	ai: {
		description:
			'Marks an open task done (a repeating one moves on to its next date). Find it with lists.openTasks first.',
	},
	async run(uow, { id, dueDate }) {
		const row = await load(uow, id);
		const stale = row.done_at !== null || (dueDate !== undefined && dueDate !== row.due_date);
		if (stale) return toTask(row);
		const now = uow.clock.now();
		const by = memberId(uow.actor);
		await tables(uow.db)
			.insertInto('lists_task_completions')
			.values({
				id: uow.ids.next('task_done'),
				task_id: id,
				due_date: row.due_date,
				done_at: now,
				done_by: by,
			})
			.execute();
		let next: string | null = null;
		if (row.rrule && row.rrule_start && row.due_date) {
			// Missed occurrences are skipped: the next one comes after today (or after the due date
			// when completed early), so chores never pile up.
			const today = todayIn((await uow.family.settings()).timeZone, now);
			const after = row.due_date > today ? row.due_date : today;
			next = nextDate({ date: row.rrule_start, rrule: row.rrule }, after);
		}
		await tables(uow.db)
			.updateTable('lists_tasks')
			.set(
				next ? { due_date: next, updated_at: now } : { done_at: now, done_by: by, updated_at: now },
			)
			.where('id', '=', id)
			.execute();
		if (next) await scheduleReminder(uow, id);
		uow.emit(taskChanged, { taskId: id });
		return toTask(await load(uow, id));
	},
});

export const reopenTask = defineAction({
	id: 'lists.reopenTask',
	target: ({ id }) => ({ table: 'lists_tasks', id, liveColumn: 'deleted_at' }),
	offline: true,
	title: 'Undo the last completion of a task',
	input: z.object({ id: TaskIdSchema }),
	output: TaskSchema,
	requires: tasksComplete.id,
	approval: 'ai',
	async run(uow, { id }) {
		const row = await load(uow, id);
		const db = tables(uow.db);
		const last = await db
			.selectFrom('lists_task_completions')
			.selectAll()
			.where('task_id', '=', id)
			.orderBy('done_at', 'desc')
			.orderBy('id', 'desc')
			.executeTakeFirst();
		if (!last) return toTask(row);
		await db.deleteFrom('lists_task_completions').where('id', '=', last.id).execute();
		await db
			.updateTable('lists_tasks')
			.set({ done_at: null, done_by: null, due_date: last.due_date, updated_at: uow.clock.now() })
			.where('id', '=', id)
			.execute();
		await scheduleReminder(uow, id);
		uow.emit(taskChanged, { taskId: id });
		return toTask(await load(uow, id));
	},
});

export const deleteTask = defineAction({
	id: 'lists.deleteTask',
	target: ({ id }) => ({ table: 'lists_tasks', id, liveColumn: 'deleted_at' }),
	targetTitle: taskTitle,
	title: 'Delete a task',
	draftTitle: 'lists:draft_title_delete_task',
	input: z.object({ id: TaskIdSchema, label: ReviewLabelSchema }),
	output: z.object({ ok: z.literal(true), id: z.string() }),
	approval: { unless: tasksEdit.id, owner: (ctx, { id }) => ownTaskOf(ctx, id) },
	undo: ({ id }) => ({ actionId: 'lists.restoreTask', input: { id } }),
	ai: {
		description:
			'Deletes a task that is no longer needed (use lists.completeTask when it was done). Find it with lists.openTasks first.',
	},
	async run(uow, { id }) {
		await load(uow, id);
		const now = uow.clock.now();
		await tables(uow.db)
			.updateTable('lists_tasks')
			.set({ deleted_at: now, updated_at: now })
			.where('id', '=', id)
			.execute();
		uow.emit(taskChanged, { taskId: id });
		return { ok: true as const, id };
	},
});

/** Takes back the deletion of a task. */
export const restoreTask = defineAction({
	id: 'lists.restoreTask',
	title: 'Bring back a deleted task',
	draftTitle: 'lists:draft_title_restore_task',
	input: z.object({ id: TaskIdSchema }),
	output: TaskSchema,
	approval: { unless: tasksEdit.id, owner: (ctx, { id }) => ownTaskOf(ctx, id) },
	async run(uow, { id }) {
		const row = await tables(uow.db)
			.selectFrom('lists_tasks')
			.select('id')
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Task not found');
		await tables(uow.db)
			.updateTable('lists_tasks')
			.set({ deleted_at: null, updated_at: uow.clock.now() })
			.where('id', '=', id)
			.execute();
		await scheduleReminder(uow, id);
		uow.emit(taskChanged, { taskId: id });
		return toTask(await load(uow, id));
	},
});

/** Done one-off tasks stay visible for a week, then only open tasks are listed. */
const DONE_VISIBLE_MS = 7 * 86_400_000;

const MAX_TASKS = 50;

export const openTasks = defineAction({
	id: 'lists.openTasks',
	title: 'Open tasks, for the AI',
	input: z.object({
		assignee: MemberIdSchema.optional().describe(
			'Leave it out (the default) for all open tasks of the family, also when the person says "give me" or "show me the open tasks" (that is who gets the answer, not whose tasks). Only for a question about one person\'s own tasks ("what do I still have to do", "Sam\'s tasks"): that person',
		),
	}),
	output: z.object({
		otherTasks: z
			.number()
			.int()
			.optional()
			.describe(
				'With `assignee`: how many more open tasks are for someone else; leave `assignee` out to see them',
			),
		tasks: z.array(
			z.object({
				id: z.string(),
				title: z.string(),
				assigneeId: z.string().nullable().describe('Null means anyone'),
				dueDate: z.string().nullable(),
				dueWeekday: z
					.string()
					.optional()
					.describe('The weekday of `dueDate`, in English: read it from here, never work it out'),
				dueTime: z.string().nullable(),
				repeats: z.boolean(),
				notes: z
					.string()
					.optional()
					.describe("What the task's notes say; left out when it has none"),
			}),
		),
		truncated: z.boolean(),
	}),
	readOnly: true,
	requires: listsView.id,
	ai: {
		description:
			'Lists the family tasks that are not done yet, soonest due first (undated last). Use it for "which tasks are open", "what do I still have to do" or "what is on the list for Sam" questions.',
	},
	async run(uow, { assignee }) {
		let query = tables(uow.db)
			.selectFrom('lists_tasks')
			.selectAll()
			.where('deleted_at', 'is', null)
			.where('done_at', 'is', null);
		// One person's tasks come with the ones anyone may do, as their calendar comes with the family's events.
		if (assignee)
			query = query.where((eb) =>
				eb.or([eb('assignee_id', '=', assignee), eb('assignee_id', 'is', null)]),
			);
		const rows = await query
			.orderBy(sql`due_date is null`)
			.orderBy('due_date')
			.orderBy(sql`due_time is null`)
			.orderBy('due_time')
			.orderBy('created_at')
			.limit(MAX_TASKS + 1)
			.execute();
		// What the person filter left out is counted, so an agent that filtered when the question
		// was about the whole family learns there is more instead of answering "nothing".
		const others = assignee
			? await tables(uow.db)
					.selectFrom('lists_tasks')
					.select((eb) => eb.fn.countAll<number>().as('n'))
					.where('deleted_at', 'is', null)
					.where('done_at', 'is', null)
					.where('assignee_id', '!=', assignee)
					.executeTakeFirstOrThrow()
			: null;
		return {
			...(others && Number(others.n) > 0 && { otherTasks: Number(others.n) }),
			tasks: rows.slice(0, MAX_TASKS).map((r) => ({
				id: r.id,
				title: r.title,
				assigneeId: r.assignee_id,
				dueDate: r.due_date,
				// Models work weekdays out wrongly from a date; code gives it.
				...(r.due_date && { dueWeekday: formatDate(r.due_date, 'en', { weekday: 'long' }) }),
				dueTime: r.due_time,
				repeats: r.rrule !== null,
				// Without them a model says a task "has no notes".
				...(digestNotes(r.notes) && { notes: digestNotes(r.notes) }),
			})),
			truncated: rows.length > MAX_TASKS,
		};
	},
});

export const listTasks = defineRoute({
	method: 'get',
	path: '/tasks',
	operationId: 'lists.listTasks',
	summary: 'Open tasks, plus one-off tasks done in the last week',
	requires: listsView.id,
	response: z.array(TaskSchema),
	async handle(ctx) {
		const since = ctx.clock.now() - DONE_VISIBLE_MS;
		const rows = await tables(ctx.db)
			.selectFrom('lists_tasks')
			.selectAll()
			.where('deleted_at', 'is', null)
			.where((eb) => eb.or([eb('done_at', 'is', null), eb('done_at', '>=', since)]))
			// Undated tasks after dated ones; then by time and creation.
			.orderBy(sql`due_date is null`)
			.orderBy('due_date')
			.orderBy(sql`due_time is null`)
			.orderBy('due_time')
			.orderBy('created_at')
			.execute();
		return rows.map(toTask);
	},
});

export const getTask = defineRoute({
	method: 'get',
	path: '/tasks/{taskId}',
	operationId: 'lists.getTask',
	summary: 'A task as an editable form',
	requires: listsView.id,
	params: z.object({ taskId: TaskIdSchema }),
	response: TaskSchema,
	async handle(ctx, { params }) {
		const row = await tables(ctx.db)
			.selectFrom('lists_tasks')
			.selectAll()
			.where('id', '=', params.taskId)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Task not found');
		return toTask(row);
	},
});
