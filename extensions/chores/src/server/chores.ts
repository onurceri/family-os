import { defineAction, defineRoute, FamosError, type UnitOfWork } from '@famos/sdk';
import { compareDates, type Recurrence, todayIn } from '@famos/time';
import { z } from 'zod';
import {
	CHORES_EDIT,
	type Chore,
	ChoreDetailSchema,
	ChoreIdSchema,
	ChoreSchema,
	type Completion,
	CreateChoreSchema,
	LEAST_DONE_DAYS,
	MarkDoneResultSchema,
	MarkDoneSchema,
	OkSchema,
	SetAssigneesResultSchema,
	SetAssigneesSchema,
	UndoDoneSchema,
	UpdateChoreSchema,
} from '../contract/index.ts';
import { choresEdit, choresUse, choresView } from './capabilities.ts';
import { scheduleChoreReminder } from './reminders.ts';
import { nextAssignee } from './rotation.ts';
import { dueAfterDone, dueFrom } from './schedule.ts';
import {
	assertMembers,
	choresChanged,
	choreView,
	choreViews,
	loadChore,
	memberIdOf,
} from './shared.ts';
import { type ChoreRow, parseRecurrence, tables } from './store.ts';

const DAY_MS = 86_400_000;
/** A finished one-off chore stays on the list this long. */
const DONE_VISIBLE_MS = 7 * DAY_MS;
const HISTORY = 30;

/** Plans the reminder for a chore as it is now (after every change that can move it). */
async function scheduleReminder(uow: UnitOfWork, id: string) {
	const row = await tables(uow.db)
		.selectFrom('chores_chores')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirst();
	if (!row) return;
	const { timeZone } = await uow.family.settings();
	await scheduleChoreReminder(
		(job, payload, o) => uow.enqueue(job, payload, o),
		row,
		uow.clock.now(),
		timeZone,
	);
}

/** The first due date of a (changed) chore: the start for a one-off, else the first on or after `from`. */
function firstDue(recurrence: Recurrence | null, startDate: string, from: string): string {
	if (!recurrence) return startDate;
	const due = dueFrom(recurrence, startDate, from);
	if (!due) throw new FamosError('bad_request', 'That repeat ends before the first due date');
	return due;
}

async function assigneeOrder(uow: UnitOfWork, choreId: string): Promise<string[]> {
	const rows = await tables(uow.db)
		.selectFrom('chores_assignees')
		.select('member_id')
		.where('chore_id', '=', choreId)
		.orderBy('position')
		.execute();
	return rows.map((r) => r.member_id);
}

async function writeAssignees(uow: UnitOfWork, choreId: string, memberIds: readonly string[]) {
	const t = tables(uow.db);
	await t.deleteFrom('chores_assignees').where('chore_id', '=', choreId).execute();
	if (memberIds.length > 0)
		await t
			.insertInto('chores_assignees')
			.values(memberIds.map((member_id, position) => ({ chore_id: choreId, member_id, position })))
			.execute();
}

const fieldsOf = (c: z.output<typeof UpdateChoreSchema>['chore']) => ({
	title: c.title,
	notes: c.notes || null,
	recurrence: c.recurrence ? JSON.stringify(c.recurrence) : null,
	start_date: c.startDate,
	rotation: c.rotation,
});

export const createChore = defineAction({
	id: 'chores.createChore',
	title: 'Add a chore',
	input: CreateChoreSchema,
	output: ChoreSchema,
	approval: { unless: choresEdit.id },
	undo: (chore) => ({ actionId: 'chores.archiveChore', input: { id: chore.id } }),
	ai: {
		description:
			'Adds a household chore that repeats or is done once (take out the bins, empty the dishwasher, water the plants), with the people who take turns doing it. Use it when the family wants shared housework organised, not for one person’s own to-do (use a task for that).',
		guidance:
			'startDate is the first day it is due, resolved from today’s date in the family time zone. recurrence is omitted for a one-off chore. Put the people who should take turns in assigneeIds using the member handles, in the order they should go (the first one is up first); judge who can do the chore from the members’ descriptions, and leave it empty when anyone may. Use rotation round_robin to take turns, least_done to even out the load, fixed when it is always the same person. Spread chores fairly across people rather than giving them all to one.',
	},
	async alreadyThere(ctx, input) {
		const row = await tables(ctx.db)
			.selectFrom('chores_chores')
			.select('id')
			.where('archived_at', 'is', null)
			.where('title', '=', input.title)
			.executeTakeFirst();
		return row !== undefined;
	},
	async run(uow, input) {
		await assertMembers(uow, input.assigneeIds);
		const recurrence = input.recurrence ?? null;
		const nextDue = firstDue(recurrence, input.startDate, input.startDate);
		const now = uow.clock.now();
		const { timeZone } = await uow.family.settings();
		const row: ChoreRow = {
			id: uow.ids.next('chore'),
			...fieldsOf(input),
			next_due: nextDue,
			assignee_id: input.assigneeIds[0] ?? null,
			created_by: memberIdOf(uow.actor),
			created_at: now,
			updated_at: now,
			archived_at: null,
		};
		await tables(uow.db).insertInto('chores_chores').values(row).execute();
		await writeAssignees(uow, row.id, input.assigneeIds);
		await scheduleReminder(uow, row.id);
		uow.emit(choresChanged, { choreId: row.id });
		return choreView(uow.db, row, todayIn(timeZone, now));
	},
});

export const updateChore = defineAction({
	id: 'chores.updateChore',
	title: 'Change a chore',
	input: UpdateChoreSchema,
	output: ChoreSchema,
	approval: { unless: choresEdit.id },
	async run(uow, { id, chore }) {
		const row = await loadChore(uow.db, id);
		const now = uow.clock.now();
		const { timeZone } = await uow.family.settings();
		const today = todayIn(timeZone, now);
		const recurrence = chore.recurrence ?? null;
		const patch = fieldsOf(chore);
		// A new start or repeat moves the schedule; anything else leaves the due date alone.
		const reschedule = patch.start_date !== row.start_date || patch.recurrence !== row.recurrence;
		const nextDue = reschedule
			? firstDue(
					recurrence,
					chore.startDate,
					compareDates(chore.startDate, today) > 0 ? chore.startDate : today,
				)
			: row.next_due;
		await tables(uow.db)
			.updateTable('chores_chores')
			.set({ ...patch, next_due: nextDue, updated_at: now })
			.where('id', '=', id)
			.execute();
		await scheduleReminder(uow, id);
		uow.emit(choresChanged, { choreId: id });
		return choreView(uow.db, await loadChore(uow.db, id), today);
	},
});

/** Hides the chore (its history stays) and stops its reminders. */
export const archiveChore = defineAction({
	id: 'chores.archiveChore',
	title: 'Archive a chore',
	input: z.object({ id: ChoreIdSchema }),
	output: OkSchema,
	approval: { unless: choresEdit.id },
	async run(uow, { id }) {
		const row = await tables(uow.db)
			.selectFrom('chores_chores')
			.select('archived_at')
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Chore not found');
		if (row.archived_at !== null) return { ok: true as const };
		const now = uow.clock.now();
		await tables(uow.db)
			.updateTable('chores_chores')
			.set({ archived_at: now, updated_at: now })
			.where('id', '=', id)
			.execute();
		uow.emit(choresChanged, { choreId: id });
		return { ok: true as const };
	},
});

export const setAssignees = defineAction({
	id: 'chores.setAssignees',
	title: 'Choose who does a chore',
	description:
		'Sets the people who take turns, in order. Whoever is up now stays if still listed, else the first one is up.',
	input: SetAssigneesSchema,
	output: SetAssigneesResultSchema,
	approval: { unless: choresEdit.id },
	undo: (r) => ({
		actionId: 'chores.setAssignees',
		input: { id: r.chore.id, memberIds: r.previousAssigneeIds },
	}),
	ai: {
		description:
			'Changes who takes turns on an existing household chore, for example to split the chores fairly between the people in the family. Use it when asked to share out, reassign or rebalance chores.',
		guidance:
			'id is the chore handle from the chores list. memberIds are member handles in turn order (the first is up first); an empty list means anyone. Judge who can do each chore from the members’ descriptions and spread the chores evenly instead of giving one person most of them. Propose one change per chore, and repeat the chore title in choreTitle.',
	},
	async run(uow, { id, memberIds }) {
		const row = await loadChore(uow.db, id);
		await assertMembers(uow, memberIds);
		const previous = await assigneeOrder(uow, id);
		await writeAssignees(uow, id, memberIds);
		const assignee =
			row.assignee_id && (memberIds as readonly string[]).includes(row.assignee_id)
				? row.assignee_id
				: (memberIds[0] ?? null);
		await tables(uow.db)
			.updateTable('chores_chores')
			.set({ assignee_id: assignee, updated_at: uow.clock.now() })
			.where('id', '=', id)
			.execute();
		await scheduleReminder(uow, id);
		uow.emit(choresChanged, { choreId: id });
		const { timeZone } = await uow.family.settings();
		const chore = await choreView(
			uow.db,
			await loadChore(uow.db, id),
			todayIn(timeZone, uow.clock.now()),
		);
		return { chore, previousAssigneeIds: previous };
	},
});

export const markDone = defineAction({
	id: 'chores.markDone',
	offline: true,
	title: 'Mark a chore done',
	description:
		'Records who did it, moves the chore to its next due date and hands it to the next person in turn. A tap on a date that has already been done changes nothing.',
	input: MarkDoneSchema,
	output: MarkDoneResultSchema,
	requires: choresUse.id,
	undo: ({ completion }) =>
		completion ? { actionId: 'chores.undoDone', input: { completionId: completion.id } } : null,
	ai: {
		description:
			'Marks a household chore done for its current due date and hands it to the next person in turn. Find it with chores.listChores first and send its nextDue as dueDate.',
		guidance: 'Set doneBy to the member who did it when the person says so.',
	},
	async run(uow, { id, dueDate, doneBy: requestedBy }) {
		const row = await loadChore(uow.db, id);
		const self = memberIdOf(uow.actor);
		const doneBy = requestedBy ?? self;
		if (!doneBy) throw new FamosError('bad_request', 'Say who did it');
		if (uow.actor.kind === 'member' && !uow.can(CHORES_EDIT)) {
			// Own turn, or a chore anyone may do; doing it for someone else needs edit.
			if (doneBy !== self || (row.assignee_id !== null && row.assignee_id !== self))
				throw new FamosError('forbidden', 'It is not your turn');
		}
		const { timeZone } = await uow.family.settings();
		const now = uow.clock.now();
		const today = todayIn(timeZone, now);
		const t = tables(uow.db);
		const taken = await t
			.selectFrom('chores_completions')
			.select('id')
			.where('chore_id', '=', id)
			.where('due_date', '=', dueDate)
			.where('undone_at', 'is', null)
			.executeTakeFirst();
		// A stale tap (already done, or the date moved on) changes nothing, and says so.
		if (taken || row.next_due !== dueDate)
			return {
				chore: await choreView(uow.db, row, today),
				completion: null,
				reason: taken ? ('already_done' as const) : ('stale' as const),
			};
		await assertMembers(uow, [doneBy]);

		const completion = {
			id: uow.ids.next('chore_done'),
			chore_id: id,
			member_id: doneBy,
			due_date: dueDate,
			prev_assignee_id: row.assignee_id,
			done_at: now,
			undone_at: null,
		};
		await t.insertInto('chores_completions').values(completion).execute();

		const recurrence = parseRecurrence(row);
		const nextDue = dueAfterDone(recurrence, row.start_date, dueDate, today);
		let assignee = row.assignee_id;
		if (nextDue) {
			const order = await assigneeOrder(uow, id);
			const recent = await t
				.selectFrom('chores_completions')
				.select(['member_id', ({ fn }) => fn.countAll<number>().as('n')])
				.where('chore_id', '=', id)
				.where('undone_at', 'is', null)
				.where('done_at', '>=', now - LEAST_DONE_DAYS * DAY_MS)
				.groupBy('member_id')
				.execute();
			assignee = nextAssignee({
				rotation: row.rotation,
				order,
				current: row.assignee_id,
				doneBy,
				counts: new Map(recent.map((r) => [r.member_id, Number(r.n)])),
			});
		}
		await t
			.updateTable('chores_chores')
			.set({ next_due: nextDue, assignee_id: assignee, updated_at: now })
			.where('id', '=', id)
			.execute();
		await scheduleReminder(uow, id);
		uow.emit(choresChanged, { choreId: id });
		return {
			chore: await choreView(uow.db, await loadChore(uow.db, id), today),
			completion: {
				id: completion.id as Completion['id'],
				choreId: id,
				memberId: doneBy,
				dueDate,
				doneAt: now,
			},
		};
	},
});

export const undoDone = defineAction({
	id: 'chores.undoDone',
	offline: true,
	title: 'Undo a completion',
	description:
		'Takes the latest completion of a chore back: the due date and whose turn it was return. Your own completion can be undone the same day.',
	input: UndoDoneSchema,
	output: ChoreSchema,
	requires: choresUse.id,
	async run(uow, { completionId }) {
		const t = tables(uow.db);
		const done = await t
			.selectFrom('chores_completions')
			.selectAll()
			.where('id', '=', completionId)
			.executeTakeFirst();
		if (!done) throw new FamosError('not_found', 'Completion not found');
		const { timeZone } = await uow.family.settings();
		const now = uow.clock.now();
		const today = todayIn(timeZone, now);
		if (uow.actor.kind === 'member' && !uow.can(CHORES_EDIT)) {
			const own =
				done.member_id === memberIdOf(uow.actor) && todayIn(timeZone, done.done_at) === today;
			if (!own)
				throw new FamosError('forbidden', 'Only your own completion of today can be undone');
		}
		const row = await loadChore(uow.db, done.chore_id);
		if (done.undone_at !== null) return choreView(uow.db, row, today);

		const newer = await t
			.selectFrom('chores_completions')
			.select('id')
			.where('chore_id', '=', done.chore_id)
			.where('undone_at', 'is', null)
			.where('id', '!=', done.id)
			.where((eb) =>
				eb.or([
					eb('done_at', '>', done.done_at),
					eb.and([eb('done_at', '=', done.done_at), eb('id', '>', done.id)]),
				]),
			)
			.executeTakeFirst();
		if (newer) throw new FamosError('conflict', 'A newer completion exists; undo that one first');

		await t
			.updateTable('chores_completions')
			.set({ undone_at: now })
			.where('id', '=', done.id)
			.execute();
		const order = await assigneeOrder(uow, done.chore_id);
		const assignee =
			done.prev_assignee_id && order.includes(done.prev_assignee_id)
				? done.prev_assignee_id
				: (order[0] ?? null);
		await t
			.updateTable('chores_chores')
			.set({ next_due: done.due_date, assignee_id: assignee, updated_at: now })
			.where('id', '=', done.chore_id)
			.execute();
		await scheduleReminder(uow, done.chore_id);
		uow.emit(choresChanged, { choreId: done.chore_id });
		return choreView(uow.db, await loadChore(uow.db, done.chore_id), today);
	},
});

const MAX_CHORES = 60;

/** Read tool for the assistant: who's turn is it. No history. */
export const listChores = defineAction({
	id: 'chores.listChores',
	title: 'Chores, for the AI',
	input: z.object({
		assignee: z
			.string()
			.optional()
			.describe('Only chores that are this member’s turn (their handle)'),
	}),
	output: z.object({
		today: z.string(),
		chores: z.array(
			z.object({
				id: z.string(),
				title: z.string(),
				nextDue: z.string().nullable().describe('Null when a one-off chore is done'),
				overdue: z.boolean(),
				assigneeId: z.string().nullable().describe('Whose turn it is; null means anyone'),
				assigneeIds: z.array(z.string()).describe('The people in turn order'),
				rotation: z.string(),
				repeats: z.boolean(),
			}),
		),
		truncated: z.boolean(),
	}),
	readOnly: true,
	requires: choresView.id,
	ai: {
		description:
			'Lists the household chores with whose turn it is and when each is due next, soonest first. Use it for "whose turn is the dishes?", "what chores do I have this week?" or when sharing chores out fairly.',
	},
	async run(uow, { assignee }) {
		const { timeZone } = await uow.family.settings();
		const today = todayIn(timeZone, uow.clock.now());
		let query = tables(uow.db)
			.selectFrom('chores_chores')
			.selectAll()
			.where('archived_at', 'is', null)
			.where('next_due', 'is not', null);
		if (assignee) query = query.where('assignee_id', '=', assignee);
		const rows = await query
			.orderBy('next_due')
			.orderBy('title')
			.limit(MAX_CHORES + 1)
			.execute();
		const chores = await choreViews(uow.db, rows.slice(0, MAX_CHORES), today);
		return {
			today,
			chores: chores.map((c) => ({
				id: c.id,
				title: c.title,
				nextDue: c.nextDue,
				overdue: c.overdue,
				assigneeId: c.assigneeId,
				assigneeIds: c.assigneeIds,
				rotation: c.rotation,
				repeats: c.recurrence !== null,
			})),
			truncated: rows.length > MAX_CHORES,
		};
	},
});

export const listAllChores = defineRoute({
	method: 'get',
	path: '/chores',
	operationId: 'chores.listAllChores',
	summary: 'The chores with whose turn it is, soonest first; a finished one-off stays for a week',
	requires: choresView.id,
	response: z.array(ChoreSchema),
	async handle(ctx) {
		const { timeZone } = await ctx.family.settings();
		const now = ctx.clock.now();
		const rows = await tables(ctx.db)
			.selectFrom('chores_chores')
			.selectAll()
			.where('archived_at', 'is', null)
			.execute();
		const chores = await choreViews(ctx.db, rows, todayIn(timeZone, now));
		return chores
			.filter(
				(c) =>
					c.nextDue !== null || (c.lastDone !== null && c.lastDone.doneAt >= now - DONE_VISIBLE_MS),
			)
			.toSorted(
				(a, b) =>
					Number(a.nextDue === null) - Number(b.nextDue === null) ||
					(a.nextDue ?? '').localeCompare(b.nextDue ?? '') ||
					a.title.localeCompare(b.title) ||
					a.id.localeCompare(b.id),
			);
	},
});

export const getChore = defineRoute({
	method: 'get',
	path: '/chores/{choreId}',
	operationId: 'chores.getChore',
	summary: 'One chore with who did it lately',
	requires: choresView.id,
	params: z.object({ choreId: ChoreIdSchema }),
	response: ChoreDetailSchema,
	async handle(ctx, { params }) {
		const row = await loadChore(ctx.db, params.choreId);
		const { timeZone } = await ctx.family.settings();
		const chore: Chore = await choreView(ctx.db, row, todayIn(timeZone, ctx.clock.now()));
		const history = await tables(ctx.db)
			.selectFrom('chores_completions')
			.selectAll()
			.where('chore_id', '=', row.id)
			.orderBy('done_at', 'desc')
			.orderBy('id', 'desc')
			.limit(HISTORY)
			.execute();
		return {
			...chore,
			history: history.map((h) => ({
				id: h.id as Completion['id'],
				choreId: h.chore_id as Completion['choreId'],
				memberId: h.member_id,
				dueDate: h.due_date,
				doneAt: h.done_at,
				undoneAt: h.undone_at,
			})),
		};
	},
});
