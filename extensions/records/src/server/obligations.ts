import {
	AiContextSchema,
	defineAction,
	defineEvent,
	defineRoute,
	FamosError,
	selfOf,
	type UnitOfWork,
} from '@famos/sdk';
import { addDays, compareDates, todayIn } from '@famos/time';
import { z } from 'zod';
import {
	AddObligationSchema,
	CompletedObligationSchema,
	CompleteObligationSchema,
	DEFAULT_AUDIENCE,
	HistoryEntrySchema,
	OBLIGATION_CONTEXT_KIND,
	ObligationIdSchema,
	ObligationSchema,
	obligationChangedPayload,
	obligationContextLabel,
	RecordIdSchema,
	RenameRecordSchema,
	UndoCompletionSchema,
	UpdateObligationSchema,
} from '../contract/index.ts';
import { recordsEdit, recordsView } from './capabilities.ts';
import { documentChanged } from './documents.ts';
import { fromRule, nextDue, toRule } from './recurrence.ts';
import { scheduleObligationReminders } from './reminders.ts';
import { OBLIGATION_KIND, PAPER_KIND } from './search.ts';
import { type ObligationRow, tables, toHistory, toObligation } from './store.ts';

/**
 * A duty belongs to the area of its `audience` capability (a vehicle's, a pet's), so those who
 * cannot see that area are not told it changed.
 */
export const obligationChanged = defineEvent(
	'records.obligation.changed',
	obligationChangedPayload,
	{ audience: (payload) => payload.audience },
);

/**
 * The capability to tell about a duty of this audience: its own while that area is installed,
 * otherwise the records' own, as a duty of a missing area is listed.
 */
function areaOf(uow: UnitOfWork, audience: string) {
	try {
		uow.can(audience);
		return audience;
	} catch {
		return DEFAULT_AUDIENCE;
	}
}

/** Tells each area among `audiences` that something on the record changed. */
function emitChanged(uow: UnitOfWork, recordId: string, audiences: Iterable<string>) {
	for (const audience of new Set([...audiences].map((a) => areaOf(uow, a))))
		uow.emit(obligationChanged, { recordId, audience });
}

const memberId = selfOf;

async function assertMember(uow: UnitOfWork, id: string | null | undefined) {
	if (!id) return;
	const active = await uow.family.members();
	if (!active.some((m) => m.id === id))
		throw new FamosError('bad_request', `Unknown member: ${id}`);
}

async function load(uow: UnitOfWork, id: string) {
	const row = await tables(uow.db)
		.selectFrom('records_obligations')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Obligation not found');
	return row;
}

/** Plans the reminders of an obligation as it is now (after an insert, edit or completion). */
async function scheduleReminders(uow: UnitOfWork, id: string) {
	const row = await load(uow, id);
	const { timeZone } = await uow.family.settings();
	await scheduleObligationReminders(
		(job, payload, o) => uow.enqueue(job, payload, o),
		row,
		uow.clock.now(),
		timeZone,
	);
}

/**
 * An obligation belongs to the area of its `audience` capability. When that area's extension is
 * not installed its page, its people and its reminders' audience are gone, so a suggestion for it
 * can never be carried out: refusing it as gone closes the suggestion instead of writing a duty
 * nobody can open.
 */
function assertAreaExists(uow: UnitOfWork, audience: string) {
	if (audience === DEFAULT_AUDIENCE) return;
	try {
		uow.can(audience);
	} catch {
		throw new FamosError('not_found', 'The area this belongs to is not installed');
	}
}

export const addObligation = defineAction({
	id: 'records.addObligation',
	title: 'Add something that needs doing to a record',
	draftTitle: 'records:draft_title_add_obligation',
	input: AddObligationSchema,
	output: ObligationSchema,
	approval: { unless: recordsEdit.id },
	undo: (o) => ({ actionId: 'records.removeObligation', input: { id: o.id } }),
	ai: {
		description:
			'Add something that comes back or has a deadline to a household record (a vehicle, a pet…): a new policy, a warranty ending, an inspection or vaccination date. Use it for a duty that is not listed yet; when a listed duty has been done, use records.completeObligation instead.',
		guidance:
			'recordId is the reference of the record it belongs to (a vehicle, a pet, a home) from that record’s list; look it up first. recordKind and recordName: copy them from that entry. dueDate is when it is due (for a policy: the end of its cover); every is how often it comes back (leave it out for once). Do not put amounts of money in title or notes.',
	},
	async alreadyThere(ctx, input) {
		const row = await tables(ctx.db)
			.selectFrom('records_obligations')
			.select('id')
			.where('record_id', '=', input.recordId)
			.where('title', '=', input.title)
			.where('due_date', '=', input.dueDate)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		return row !== undefined;
	},
	async run(uow, input) {
		assertAreaExists(uow, input.audience);
		await assertMember(uow, input.assigneeId);
		const now = uow.clock.now();
		// A date that only passes has nothing to roll forward to.
		const every = input.lapses ? null : (input.every ?? null);
		const row: ObligationRow = {
			id: uow.ids.next('obligation'),
			record_id: input.recordId,
			record_kind: input.recordKind,
			record_name: input.recordName,
			record_url: input.recordUrl ?? null,
			kind: input.kind,
			title: input.title,
			due_date: input.dueDate,
			rrule: every ? toRule(every) : null,
			rrule_start: every ? input.dueDate : null,
			lead_days: input.leadDays,
			assignee_id: input.assigneeId ?? null,
			audience: input.audience,
			notes: input.notes ?? null,
			lapses: input.lapses ? 1 : 0,
			last_done_on: null,
			archived_at: null,
			source_kind: null,
			source_id: null,
			created_by: memberId(uow.actor),
			created_at: now,
			updated_at: now,
		};
		await tables(uow.db).insertInto('records_obligations').values(row).execute();
		await uow.ai.reindex(OBLIGATION_KIND, row.id);
		await scheduleReminders(uow, row.id);
		emitChanged(uow, row.record_id, [row.audience]);
		return toObligation(row);
	},
});

export const updateObligation = defineAction({
	id: 'records.updateObligation',
	target: ({ id }) => ({ table: 'records_obligations', id }),
	title: 'Change an obligation',
	draftTitle: 'records:draft_title_update_obligation',
	input: UpdateObligationSchema,
	output: ObligationSchema,
	approval: { unless: recordsEdit.id },
	async run(uow, { id, obligation }) {
		const row = await load(uow, id);
		if (row.archived_at !== null) throw new FamosError('conflict', 'This obligation is archived');
		if (obligation.audience !== undefined) assertAreaExists(uow, obligation.audience);
		await assertMember(uow, obligation.assigneeId);
		const lapses = obligation.lapses ?? row.lapses === 1;
		// Left out, the repeat stays as it is, like every other field a change may skip.
		const { every } = obligation;
		const rrule = lapses ? null : every === undefined ? row.rrule : every ? toRule(every) : null;
		// The series keeps counting from its first date unless the repeat or the due date changed.
		const keepAnchor = rrule !== null && rrule === row.rrule && obligation.dueDate === row.due_date;
		await tables(uow.db)
			.updateTable('records_obligations')
			.set({
				kind: obligation.kind ?? row.kind,
				title: obligation.title,
				due_date: obligation.dueDate,
				rrule,
				rrule_start: rrule ? (keepAnchor ? row.rrule_start : obligation.dueDate) : null,
				lead_days: obligation.leadDays ?? row.lead_days,
				assignee_id: obligation.assigneeId === undefined ? row.assignee_id : obligation.assigneeId,
				audience: obligation.audience ?? row.audience,
				notes: obligation.notes === undefined ? row.notes : obligation.notes,
				lapses: lapses ? 1 : 0,
				updated_at: uow.clock.now(),
			})
			.where('id', '=', id)
			.execute();
		await uow.ai.reindex(OBLIGATION_KIND, id);
		await scheduleReminders(uow, id);
		// Moved to another area: both the one it left and the one it joined hear of it.
		emitChanged(uow, row.record_id, [row.audience, obligation.audience ?? row.audience]);
		return toObligation(await load(uow, id));
	},
});

export const completeObligation = defineAction({
	id: 'records.completeObligation',
	target: ({ id }) => ({ table: 'records_obligations', id }),
	title: 'Mark an obligation done',
	draftTitle: 'records:draft_title_complete_obligation',
	description:
		'Adds a history entry. A repeating obligation moves on to its next due date; a one-off is archived as done.',
	input: CompleteObligationSchema,
	output: CompletedObligationSchema,
	approval: { unless: recordsEdit.id },
	// A model reads a renewal notice or a reminder as "done" all too easily; something that really
	// was done comes with the day it happened or the date it now runs to. Without either, the
	// duty is still to do, and the model asks the person instead of suggesting it.
	refuseProposal: async (ctx, { id, doneOn, nextDueDate }) => {
		if (doneOn !== undefined || nextDueDate !== undefined) return null;
		const row = await tables(ctx.db)
			.selectFrom('records_obligations')
			.select('title')
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) return null;
		return `Nothing says when ${row.title} was done: a reminder or a renewal notice is not done. Mark it done only with the day it was done (doneOn) or the date it now runs to (nextDueDate).`;
	},
	undo: ({ id, before }) =>
		before ? { actionId: 'records.undoCompletion', input: { id, ...before } } : null,
	ai: {
		description:
			'Record that a household duty has been done (for example insurance renewed, a service done, a vaccination given) and set the next due date. Use it only when a listed duty has already been done (a policy renewed, a payment made, a service done), never for one that is only coming up or due.',
		guidance:
			'id is the duty’s reference from the list of duties; look it up first. doneOn is the day it was done (for a policy: the day the new cover starts). nextDueDate is when the new cover ends or the next one is due, when it is known; leave it out otherwise. label is what the person called it, in their words. note is short and has no amounts of money.',
	},
	async run(uow, { id, doneOn, note, dueDate, nextDueDate }) {
		const row = await load(uow, id);
		// Already done, or rolled forward since the caller looked (or to the date asked for): nothing to do.
		if (
			row.archived_at !== null ||
			(dueDate !== undefined && dueDate !== row.due_date) ||
			(nextDueDate !== undefined && nextDueDate === row.due_date)
		)
			return { ...toObligation(row), before: null };
		const now = uow.clock.now();
		const { timeZone } = await uow.family.settings();
		const today = todayIn(timeZone, now);
		const done = doneOn ?? today;
		if (nextDueDate !== undefined && compareDates(nextDueDate, done) <= 0)
			throw new FamosError('bad_request', 'The next due date must be after the day it was done');
		const entryId = uow.ids.next('obligation_done');
		await tables(uow.db)
			.insertInto('records_obligation_history')
			.values({
				id: entryId,
				obligation_id: id,
				due_date: row.due_date,
				done_on: done,
				done_by: memberId(uow.actor),
				note: note ?? null,
				created_at: now,
			})
			.execute();
		const every = fromRule(row.rrule);
		// Missed occurrences are skipped: the next one comes after today (or after the due date
		// when done early), so a late renewal never leaves an old date behind. A date given by
		// the caller wins and, for a repeating duty, becomes the new anchor of the series.
		const next =
			nextDueDate ??
			(every && row.rrule_start
				? nextDue(row.rrule_start, every, row.due_date > today ? row.due_date : today)
				: null);
		await tables(uow.db)
			.updateTable('records_obligations')
			.set(
				next
					? {
							due_date: next,
							last_done_on: done,
							...(nextDueDate !== undefined && every && { rrule_start: nextDueDate }),
							updated_at: now,
						}
					: { last_done_on: done, archived_at: now, updated_at: now },
			)
			.where('id', '=', id)
			.execute();
		if (next) await scheduleReminders(uow, id);
		// A one-off duty that is done leaves the active list, and search with it.
		else await uow.ai.remove(OBLIGATION_KIND, id);
		emitChanged(uow, row.record_id, [row.audience]);
		return {
			...toObligation(await load(uow, id)),
			before: {
				entryId,
				dueDate: row.due_date,
				rruleStart: row.rrule_start,
				lastDoneOn: row.last_done_on,
			},
		};
	},
});

/**
 * Takes a completion back (the undo of `records.completeObligation`): its history entry goes,
 * and the obligation is open again with the due date it had. Taking it back twice changes
 * nothing: once the entry is gone, there is nothing left to restore.
 */
export const undoCompletion = defineAction({
	id: 'records.undoCompletion',
	title: 'Take back marking an obligation done',
	draftTitle: 'records:draft_title_undo_completion',
	input: UndoCompletionSchema,
	output: ObligationSchema,
	approval: { unless: recordsEdit.id },
	async run(uow, { id, entryId, dueDate, rruleStart, lastDoneOn }) {
		const row = await load(uow, id);
		const db = tables(uow.db);
		const entry = await db
			.selectFrom('records_obligation_history')
			.select('id')
			.where('id', '=', entryId)
			.where('obligation_id', '=', id)
			.executeTakeFirst();
		if (!entry) return toObligation(row);
		await db.deleteFrom('records_obligation_history').where('id', '=', entryId).execute();
		await db
			.updateTable('records_obligations')
			.set({
				due_date: dueDate,
				rrule_start: row.rrule ? rruleStart : null,
				last_done_on: lastDoneOn,
				archived_at: null,
				updated_at: uow.clock.now(),
			})
			.where('id', '=', id)
			.execute();
		await uow.ai.reindex(OBLIGATION_KIND, id);
		await scheduleReminders(uow, id);
		emitChanged(uow, row.record_id, [row.audience]);
		return toObligation(await load(uow, id));
	},
});

export const removeObligation = defineAction({
	id: 'records.removeObligation',
	target: ({ id }) => ({ table: 'records_obligations', id }),
	title: 'Remove an obligation',
	draftTitle: 'records:draft_title_remove_obligation',
	input: z.object({ id: ObligationIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: recordsEdit.id },
	async run(uow, { id }) {
		const row = await load(uow, id);
		const db = tables(uow.db);
		await db.deleteFrom('records_obligation_history').where('obligation_id', '=', id).execute();
		await db.deleteFrom('records_obligations').where('id', '=', id).execute();
		await uow.ai.remove(OBLIGATION_KIND, id);
		emitChanged(uow, row.record_id, [row.audience]);
		return { ok: true as const };
	},
});

/**
 * Called by a domain extension when it archives a record: its obligations and documents are
 * archived (kept, hidden, no more reminders). Idempotent. A domain calls it inside its own
 * archive action (`uow.run`). Run inside another action it is held to its own rule: the person
 * must hold `records.edit` (a run that would only be a suggestion is refused, never applied).
 */
export const archiveForRecord = defineAction({
	id: 'records.archiveForRecord',
	title: 'Archive the obligations and documents of a record',
	draftTitle: 'records:draft_title_archive_for_record',
	input: z.object({ recordId: RecordIdSchema }),
	output: z.object({ obligations: z.number().int(), documents: z.number().int() }),
	approval: { unless: recordsEdit.id },
	async run(uow, { recordId }) {
		const now = uow.clock.now();
		const db = tables(uow.db);
		const goneObligations = await db
			.selectFrom('records_obligations')
			.select(['id', 'audience'])
			.where('record_id', '=', recordId)
			.where('archived_at', 'is', null)
			.execute();
		const gonePapers = await db
			.selectFrom('records_documents')
			.select('id')
			.where('record_id', '=', recordId)
			.where('archived_at', 'is', null)
			.execute();
		for (const { id } of goneObligations) await uow.ai.remove(OBLIGATION_KIND, id);
		for (const { id } of gonePapers) await uow.ai.remove(PAPER_KIND, id);
		const obligations = await db
			.updateTable('records_obligations')
			.set({ archived_at: now, updated_at: now })
			.where('record_id', '=', recordId)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		const documents = await db
			.updateTable('records_documents')
			.set({ archived_at: now, updated_at: now })
			.where('record_id', '=', recordId)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		emitChanged(
			uow,
			recordId,
			goneObligations.map((o) => o.audience),
		);
		if (gonePapers.length > 0) uow.emit(documentChanged, { recordId });
		return {
			obligations: Number(obligations.numUpdatedRows),
			documents: Number(documents.numUpdatedRows),
		};
	},
});

/** The owner of a record renamed it (or moved its page): lists that span records follow. */
export const renameRecord = defineAction({
	id: 'records.renameRecord',
	title: 'Update the name of a record',
	draftTitle: 'records:draft_title_rename_record',
	input: RenameRecordSchema,
	output: z.object({ obligations: z.number().int() }),
	approval: { unless: recordsEdit.id },
	async run(uow, { recordId, name, url }) {
		// `updated_at` stays: reminders read the name when they run and must not be invalidated.
		const result = await tables(uow.db)
			.updateTable('records_obligations')
			.set({ record_name: name, ...(url !== undefined && { record_url: url }) })
			.where('record_id', '=', recordId)
			.executeTakeFirst();
		// The record's name is part of what search reads for its duties and papers.
		const db = tables(uow.db);
		const duties = await db
			.selectFrom('records_obligations')
			.select(['id', 'audience'])
			.where('record_id', '=', recordId)
			.where('archived_at', 'is', null)
			.execute();
		const papers = await db
			.selectFrom('records_documents')
			.select('id')
			.where('record_id', '=', recordId)
			.where('archived_at', 'is', null)
			.execute();
		for (const { id } of duties) await uow.ai.reindex(OBLIGATION_KIND, id);
		for (const { id } of papers) await uow.ai.reindex(PAPER_KIND, id);
		emitChanged(
			uow,
			recordId,
			duties.map((d) => d.audience),
		);
		if (papers.length > 0) uow.emit(documentChanged, { recordId });
		return { obligations: Number(result.numUpdatedRows) };
	},
});

const MAX_CONTEXT = 50;

/**
 * Open obligations that still matter on `today`: every duty, late or not, but a date that only
 * passes (a warranty ends) no longer once its day is over.
 */
export const openUntil = (db: ReturnType<typeof tables>, today: string) =>
	db
		.selectFrom('records_obligations')
		.selectAll()
		.where('archived_at', 'is', null)
		.where((eb) => eb.or([eb('lapses', '=', 0), eb('due_date', '>=', today)]));

/**
 * An obligation belongs to the area of its `audience` capability (a vehicle's, say). The AI sees
 * it only when it may use that area (and the member it asks for may): a locked area's
 * capabilities are gone for it, so its duties, names and dates never reach a prompt.
 * Unknown audience: records.view.
 */
export const aiMayRead = (uow: UnitOfWork, audience: string) => {
	if (uow.actor.kind !== 'ai') return true;
	try {
		return uow.can(audience);
	} catch {
		return uow.can(DEFAULT_AUDIENCE);
	}
};

/**
 * What the AI may know about open obligations, so a shared policy or invoice can complete the
 * right one (`records.completeObligation`). Read by the Inbox as the AI actor; a locked
 * records area refuses it. Soonest first.
 */
export const aiContext = defineAction({
	id: 'records.aiContext',
	title: 'Open obligations, for the AI',
	input: z.object({}),
	output: AiContextSchema,
	readOnly: true,
	requires: recordsView.id,
	async run(uow) {
		const { timeZone } = await uow.family.settings();
		const today = todayIn(timeZone, uow.clock.now());
		const rows = await openUntil(tables(uow.db), today)
			.orderBy('due_date')
			.orderBy('created_at')
			.limit(500)
			.execute();
		const visible = rows.filter((r) => aiMayRead(uow, r.audience));
		return {
			kind: OBLIGATION_CONTEXT_KIND,
			label: 'Things that need doing',
			items: visible.slice(0, MAX_CONTEXT).map((r) => {
				const every = fromRule(r.rrule);
				const repeat = every?.years
					? `, every ${every.years === 1 ? 'year' : `${every.years} years`}`
					: every?.months
						? `, every ${every.months === 1 ? 'month' : `${every.months} months`}`
						: '';
				return {
					id: r.id,
					label: obligationContextLabel(r.title, r.record_name),
					details: `due ${r.due_date}${repeat}`,
				};
			}),
		};
	},
});

export const upcoming = defineAction({
	id: 'records.upcoming',
	title: 'Duties that are overdue or due soon, for the AI',
	input: z.object({
		days: z.number().int().min(0).max(366).default(30).describe('How many days ahead to look'),
	}),
	output: z.object({
		obligations: z.array(
			z.object({
				id: z.string(),
				title: z.string(),
				record: z.string().describe('What it is about, e.g. the vehicle or pet'),
				recordId: z.string(),
				dueDate: z.string(),
				overdue: z.boolean(),
				assigneeId: z.string().nullable(),
			}),
		),
		nextAfter: z
			.object({
				id: z.string(),
				title: z.string(),
				record: z.string(),
				recordId: z.string(),
				dueDate: z.string(),
			})
			.optional()
			.describe('Only when nothing is due in the days asked about: the first duty due after them'),
	}),
	readOnly: true,
	requires: recordsView.id,
	ai: {
		description:
			'Duties of the household (vehicle inspection, insurance, vaccination, service) that are overdue or due within the next days, soonest first. Use it for "what is coming up" questions.',
	},
	async run(uow, { days }) {
		const { timeZone } = await uow.family.settings();
		const today = todayIn(timeZone, uow.clock.now());
		const until = addDays(today, days);
		const rows = await openUntil(tables(uow.db), today)
			.where('due_date', '<=', until)
			.orderBy('due_date')
			.orderBy('created_at')
			.limit(200)
			.execute();
		const obligations = rows
			.filter((r) => aiMayRead(uow, r.audience))
			.slice(0, MAX_CONTEXT)
			.map((r) => ({
				id: r.id,
				title: r.title,
				record: r.record_name,
				recordId: r.record_id,
				dueDate: r.due_date,
				overdue: r.lapses === 0 && compareDates(r.due_date, today) < 0,
				assigneeId: r.assignee_id,
			}));
		if (obligations.length > 0) return { obligations };
		// Nothing in the window is half an answer when the car's inspection is due a fortnight after
		// it: the first one later is given, so the answer can say when it is.
		const later = await openUntil(tables(uow.db), today)
			.where('due_date', '>', until)
			.orderBy('due_date')
			.orderBy('created_at')
			.limit(200)
			.execute();
		const next = later.find((r) => aiMayRead(uow, r.audience));
		return {
			obligations,
			...(next && {
				nextAfter: {
					id: next.id,
					title: next.title,
					record: next.record_name,
					recordId: next.record_id,
					dueDate: next.due_date,
				},
			}),
		};
	},
});

export const listObligations = defineRoute({
	method: 'get',
	path: '/obligations',
	operationId: 'records.listObligations',
	summary: 'The open obligations of a record (or its finished one-offs), soonest first',
	requires: recordsView.id,
	query: z.object({
		recordId: RecordIdSchema,
		status: z.enum(['open', 'archived']).default('open'),
	}),
	response: z.array(ObligationSchema),
	async handle(ctx, { query }) {
		let q = tables(ctx.db)
			.selectFrom('records_obligations')
			.selectAll()
			.where('record_id', '=', query.recordId);
		q =
			query.status === 'open'
				? q.where('archived_at', 'is', null).orderBy('due_date')
				: q.where('archived_at', 'is not', null).orderBy('archived_at', 'desc');
		return (await q.orderBy('created_at').execute()).map(toObligation);
	},
});

export const getObligationHistory = defineRoute({
	method: 'get',
	path: '/obligations/{obligationId}/history',
	operationId: 'records.getObligationHistory',
	summary: 'When an obligation was done, newest first',
	requires: recordsView.id,
	params: z.object({ obligationId: ObligationIdSchema }),
	response: z.array(HistoryEntrySchema),
	async handle(ctx, { params }) {
		const rows = await tables(ctx.db)
			.selectFrom('records_obligation_history')
			.selectAll()
			.where('obligation_id', '=', params.obligationId)
			.orderBy('created_at', 'desc')
			.orderBy('id', 'desc')
			.execute();
		return rows.map(toHistory);
	},
});

export const listUpcoming = defineRoute({
	method: 'get',
	path: '/upcoming',
	operationId: 'records.listUpcoming',
	summary: 'Open obligations of every record that are overdue or due within the next days',
	requires: recordsView.id,
	query: z.object({ days: z.coerce.number().int().min(0).max(366).default(30) }),
	response: z.array(ObligationSchema),
	async handle(ctx, { query }) {
		const { timeZone } = await ctx.family.settings();
		const today = todayIn(timeZone, ctx.clock.now());
		const rows = await openUntil(tables(ctx.db), today)
			.where('due_date', '<=', addDays(today, query.days))
			.orderBy('due_date')
			.orderBy('created_at')
			.limit(200)
			.execute();
		return rows.map(toObligation);
	},
});
