import {
	type Actor,
	type DraftAlternative,
	defineAction,
	defineJob,
	defineRoute,
	idSchema,
	personPresent,
	selfOf,
} from '@famos/sdk';
import { z } from 'zod';
import { GONE, SETTLED } from '../action-runner.ts';
import { CORE_CAPABILITIES } from '../core-capabilities.ts';
import { EXPIRE_JOB, scheduleExpiry, WAITING_STATUSES } from '../draft-expiry.ts';
import { waitingUnit } from '../draft-notices.ts';
import { readStoredInput } from '../stored-input.ts';
import type { CoreTables, DraftRow } from '../tables.ts';
import type { CoreExtensionDeps } from './deps.ts';

export const DRAFT_STATUSES = [
	'pending',
	'approved',
	'rejected',
	'applied',
	'failed',
	'undone',
	'expired',
] as const;

export const DraftSchema = z.object({
	id: z.string(),
	actionId: z.string(),
	input: z.unknown(),
	editedInput: z.unknown().nullable(),
	/** `expired`: nobody decided it and the day it was about has passed (it never runs). */
	status: z.enum(DRAFT_STATUSES),
	proposedBy: z.unknown(),
	/**
	 * The app it came through, by its current name, or null: a connected app (`connected`), or an
	 * AI app working through an app key or a sign-in (`ai`, named for the sign-in's app or the key).
	 */
	app: z.object({ id: z.string(), name: z.string(), kind: z.enum(['connected', 'ai']) }).nullable(),
	sourceKind: z.string().nullable(),
	sourceId: z.string().nullable(),
	summary: z.string().nullable(),
	confidence: z.number().nullable(),
	uncertainFields: z.array(z.string()),
	/** The words of the shared message it rests on, as the message writes them; null when none. */
	quote: z.string().nullable(),
	/** `failed` when applying it did not work (the stored message can carry internals), else null. */
	error: z.literal('failed').nullable(),
	/** Addressed to this member alone (a memory, a question): only they decide it. */
	forMember: z.string().nullable(),
	createdAt: z.number(),
	decidedAt: z.number().nullable(),
	/** Approved by a person's auto-approval setting; `decidedBy` is who turned it on. */
	autoApproved: z.boolean(),
	decidedBy: z.string().nullable(),
	/** Applied and its action can take it back (Undo). */
	undoable: z.boolean(),
	/**
	 * Why a draft is closed when a person did not decide it on its merits: `gone` (what
	 * it was about no longer exists; a waiting one is shown as expired with it), `settled` (what it asked for was already so) or `withdrawn`
	 * (the person behind it took it back). Null otherwise.
	 */
	reason: z.enum(['gone', 'settled', 'withdrawn']).nullable(),
	/** i18n key naming what the draft proposes, for a draft no presenter or summary describes. */
	titleKey: z.string().nullable(),
	/**
	 * What it is about, by name ("Piano lesson"): the name stored with it, else what the thing it
	 * points at is called now. Null when nothing names it.
	 */
	subject: z.string().nullable(),
	/** Pending only: what it proposes seems to exist already ("this may already be there"). */
	mayExist: z.boolean(),
	/** Pending only: part of what it proposes seems to exist already. */
	mayExistSome: z.boolean(),
	/**
	 * Pending only: another action it could become, offered to the reviewer (a new event whose
	 * title names one already on the calendar becomes a change of that one). `at` is when the
	 * thing already there is. Choosing it is `core.replaceDraft`.
	 */
	instead: z
		.object({
			actionId: z.string(),
			input: z.unknown(),
			at: z.object({ date: z.string(), time: z.string().optional() }).optional(),
		})
		.nullable(),
	/**
	 * Waiting only: what the fields it changes hold now, keyed like its input, so the card reads
	 * "old → new". Null for actions that do not say, and when the thing is gone.
	 */
	before: z.record(z.string(), z.unknown()).nullable(),
	/** The action it proposed before a reviewer chose its alternative; null when it never changed. */
	replacedFrom: z.string().nullable(),
	/** Whether the member reading it may decide it (approve or reject it on its merits). */
	canDecide: z.boolean(),
	/** Undone only: it was suggested again (`core.suggestDraftAgain`), as another draft. */
	suggestedAgain: z.boolean(),
	/**
	 * Waiting only: nobody can decide it now because the extension its action belongs to is not
	 * installed or is turned off. `labels` are that extension's names by language when known (an
	 * extension that is not installed has no texts loaded). Null otherwise.
	 */
	unavailable: z
		.object({
			reason: z.enum(['not_installed', 'turned_off']),
			extension: z.string(),
			labels: z.record(z.string(), z.string()),
		})
		.nullable(),
});

/** Why a closed draft is closed, when no one decided it on its merits. */
export function draftReason(row: DraftRow): 'gone' | 'settled' | 'withdrawn' | null {
	if (row.status !== 'rejected') return null;
	if (row.error === GONE) return 'gone';
	if (row.error === SETTLED) return 'settled';
	// Only a person taking back their own suggestion (or what their own share produced)
	// withdraws it; declining what an assistant or MCP client proposed is an ordinary rejection.
	const by = JSON.parse(row.proposed_by) as Actor;
	const proposer = selfOf(by);
	if (proposer !== null) return row.decided_by === proposer ? 'withdrawn' : null;
	// What a member shared is theirs to take back; what an AI they talk to proposed is not.
	return by.kind === 'ai' && by.mode === 'share' && row.decided_by === by.onBehalfOf
		? 'withdrawn'
		: null;
}

const toDraft = (
	row: DraftRow,
	undoable = false,
	mayExist: boolean | 'some' = false,
	titleKey: string | null = null,
	instead: DraftAlternative | null = null,
	canDecide = false,
	before: Record<string, unknown> | null = null,
	subject: string | null = null,
	suggestedAgain = false,
	read: (json: string) => unknown = JSON.parse,
	unavailable: z.infer<typeof DraftSchema>['unavailable'] = null,
	waitingGone = false,
	app: { id: string; name: string; kind: 'connected' | 'ai' } | null = null,
): z.infer<typeof DraftSchema> => ({
	id: row.id,
	actionId: row.action_id,
	input: read(row.input),
	editedInput: row.edited_input === null ? null : read(row.edited_input),
	status: row.status,
	proposedBy: JSON.parse(row.proposed_by),
	app,
	sourceKind: row.source_kind,
	sourceId: row.source_id,
	summary: row.summary,
	confidence: row.confidence,
	uncertainFields: row.uncertain_fields ? (JSON.parse(row.uncertain_fields) as string[]) : [],
	quote: row.quote,
	// The stored message can carry internals (SQL, paths); members see only that it failed.
	error: row.error === null || row.error === GONE || row.error === SETTLED ? null : 'failed',
	forMember: row.for_member,
	createdAt: row.created_at,
	decidedAt: row.decided_at,
	autoApproved: row.auto_approved === 1,
	decidedBy: row.decided_by,
	undoable,
	reason: waitingGone ? 'gone' : draftReason(row),
	titleKey,
	subject,
	mayExist: mayExist === true,
	mayExistSome: mayExist === 'some',
	instead: instead && {
		actionId: instead.actionId,
		input: instead.input,
		...(instead.at && { at: instead.at }),
	},
	before,
	replacedFrom:
		row.replaced === null ? null : (JSON.parse(row.replaced) as { actionId: string }).actionId,
	canDecide,
	suggestedAgain,
	unavailable,
});

/** Reading suggestions and deciding them: approve, reject, undo, suggest again, replace. */
export function createDrafts(deps: CoreExtensionDeps) {
	const listDrafts = defineRoute({
		method: 'get',
		path: '/drafts',
		operationId: 'core.listDrafts',
		summary: 'Drafts awaiting or past a decision',
		requires: CORE_CAPABILITIES.draftsPropose.id,
		query: z.object({
			status: z.enum(DRAFT_STATUSES).optional(),
			/** Only drafts proposed from this source, e.g. `inbox`. */
			sourceKind: z.string().max(40).optional(),
			sourceId: z.string().max(80).optional(),
			limit: z.coerce.number().int().min(1).max(200).default(50),
		}),
		response: z.array(DraftSchema),
		async handle(ctx, { query, actor }) {
			let q = ctx.db.withTables<CoreTables>().selectFrom('core_drafts').selectAll();
			// Drafts addressed to one member (memory, questions) are visible to them alone.
			const self = selfOf(actor);
			q = q.where((eb) =>
				self !== null
					? eb.or([eb('for_member', 'is', null), eb('for_member', '=', self)])
					: eb('for_member', 'is', null),
			);
			// A waiting draft about a day that has passed is expired, even before the daily job.
			if (query.status === 'expired') q = q.where('status', 'in', ['expired', ...WAITING_STATUSES]);
			else if (query.status) q = q.where('status', '=', query.status);
			if (query.sourceKind) q = q.where('source_kind', '=', query.sourceKind);
			if (query.sourceId) q = q.where('source_id', '=', query.sourceId);
			// A member reads the suggestions they may decide or are the person behind, never
			// another member's (a supervised child's appointment is not for a teenager to see).
			const runner = deps.runner();
			const readable = (row: DraftRow) =>
				!personPresent(actor) ||
				runner.mayDecide(row, actor) ||
				runner.isProposer(actor, row) ||
				// Whoever would have decided it sees why it waits.
				(runner.unavailable(row) !== null &&
					deps.access().can(actor, CORE_CAPABILITIES.draftsApprove.id));
			// Newest first, a page at a time: only as many drafts are read as it takes to fill the
			// answer with ones this reader may see.
			const page = Math.max(50, query.limit * 2);
			const rows: DraftRow[] = [];
			let after: { created_at: number; id: string } | null = null;
			for (;;) {
				const before = after;
				const batch: DraftRow[] = await (before
					? q.where((eb) =>
							eb.or([
								eb('created_at', '<', before.created_at),
								eb.and([eb('created_at', '=', before.created_at), eb('id', '<', before.id)]),
							]),
						)
					: q
				)
					.orderBy('created_at', 'desc')
					.orderBy('id', 'desc')
					.limit(page)
					.execute();
				for (const row of batch) {
					if (rows.length < query.limit && readable(row)) rows.push(row);
				}
				if (rows.length >= query.limit || batch.length < page) break;
				after = batch.at(-1) ?? null;
			}
			const passed = await runner.passedCheck();
			// What it is about is gone: it can never be applied, so it is closed like an expired one.
			const gone = await runner.goneAmong(rows.filter((row) => !passed(row)));
			const shown = rows
				.map(
					(row): DraftRow =>
						passed(row) || gone.has(row.id) ? { ...row, status: 'expired' } : row,
				)
				.filter((row) => !query.status || row.status === query.status);
			return Promise.all(shown.map((row) => view(row, actor, gone.has(row.id))));
		},
	});

	const countWaiting = defineRoute({
		method: 'get',
		path: '/drafts/waiting',
		operationId: 'core.countWaitingDrafts',
		summary:
			'How many suggestions wait for a decision (a count only): what Quick add shows to decide',
		requires: CORE_CAPABILITIES.draftsWaiting.id,
		response: z.object({ count: z.number().int() }),
		async handle(ctx, { actor }) {
			// Drafts addressed to a member count for them alone (never for displays or others).
			const rows = await ctx.db
				.withTables<CoreTables>()
				.selectFrom('core_drafts')
				// Only what deciding, expiry, a gone target and grouping look at: never the texts.
				.select([
					'id',
					'action_id',
					'status',
					'input',
					'edited_input',
					'for_member',
					'proposed_by',
					'source_kind',
					'source_id',
				])
				// A suggestion whose applying failed still waits for someone to try it again.
				.where('status', 'in', [...WAITING_STATUSES])
				.where((eb) => {
					const self = selfOf(actor);
					return self !== null
						? eb.or([eb('for_member', 'is', null), eb('for_member', '=', self)])
						: eb('for_member', 'is', null);
				})
				.execute();
			// A member's count is what they can decide: not their own suggestions, nor what an
			// approver must look at. A display only shows that something waits.
			const decidable = personPresent(actor)
				? rows.filter((row) => deps.runner().mayDecide(row, actor))
				: rows;
			// One about a day that has passed no longer waits (it expires).
			const passed = await deps.runner().passedCheck();
			const open = decidable.filter((row) => !passed(row));
			// One whose target is gone can never be applied: nothing to decide.
			const gone = await deps.runner().goneAmong(open);
			// What a member shared is one thing to decide, however many suggestions it made.
			return { count: new Set(open.filter((row) => !gone.has(row.id)).map(waitingUnit)).size };
		},
	});

	/**
	 * Which of a source's items have a suggestion waiting that the signed-in member may decide
	 * (theirs alone, or one they could approve). Lets an extension show an item to the people who
	 * must decide it without reading the drafts table. Not offered to any model.
	 */
	const decidableSources = defineAction({
		id: 'core.decidableSources',
		title: 'Which items of a source have a suggestion the member may decide',
		input: z.object({ sourceKind: z.string().min(1).max(40) }),
		output: z.object({ sourceIds: z.array(z.string()) }),
		readOnly: true,
		async run(uow, { sourceKind }) {
			const self = selfOf(uow.actor);
			if (self === null) return { sourceIds: [] };
			const rows = await uow.db
				.withTables<CoreTables>()
				.selectFrom('core_drafts')
				.selectAll()
				.where('source_kind', '=', sourceKind)
				.where('status', 'in', ['pending', 'failed'])
				.where((eb) => eb.or([eb('for_member', 'is', null), eb('for_member', '=', self)]))
				.execute();
			const ids = new Set<string>();
			const passed = await deps.runner().passedCheck(uow.db);
			const gone = await deps.runner().goneAmong(rows, uow.db);
			for (const row of rows) {
				if (passed(row) || gone.has(row.id)) continue;
				if (row.source_id && deps.runner().mayDecide(row, uow.actor)) ids.add(row.source_id);
			}
			return { sourceIds: [...ids] };
		},
	});

	const expireDrafts = defineJob({
		name: EXPIRE_JOB,
		payload: z.object({}),
		maxAttempts: 3,
		async handle(ctx) {
			const count = await deps.runner().expirePassed();
			if (count > 0) ctx.logger.info({ count }, 'suggestions about a passed day expired');
			await scheduleExpiry(ctx);
		},
	});

	const DraftParams = z.object({ draftId: idSchema('draft') });

	const editDraft = defineAction({
		id: 'core.editDraft',
		title: 'Save a change to a waiting suggestion',
		input: z.object({ draftId: idSchema('draft'), input: z.unknown() }),
		output: z.object({ draftId: z.string(), editedInput: z.unknown() }),
		// The runner decides who may: whoever may decide the suggestion, or the member behind it.
		requires: CORE_CAPABILITIES.draftsPropose.id,
		approval: 'never',
		async run(uow, { draftId, input }) {
			const row = await deps.runner().editDraft(uow, draftId, input);
			return {
				draftId,
				editedInput: row.edited_input === null ? null : JSON.parse(row.edited_input),
			};
		},
	});
	const unavailableOf = (row: DraftRow): z.infer<typeof DraftSchema>['unavailable'] => {
		if (row.status !== 'pending' && row.status !== 'failed') return null;
		const why = deps.runner().unavailable(row);
		if (!why) return null;
		return { ...why, labels: deps.extensionInstall.namesOf(why.extension) };
	};
	const view = async (row: DraftRow, reader: Actor, waitingGone = false) =>
		toDraft(
			row,
			deps.runner().undoStep(row) !== null,
			await deps.runner().mayExist(row),
			deps.registry().actions.get(row.action_id)?.draftTitle ?? null,
			await deps.runner().alternative(row),
			deps.runner().mayDecide(row, reader),
			await deps.runner().currentValues(row),
			await deps.runner().subject(row),
			await deps.runner().suggestedAgain(row),
			(json) => readStoredInput(deps.registry().actions.get(row.action_id), json),
			unavailableOf(row),
			waitingGone,
			await deps.runner().appBehind(row),
		);

	const approve = defineRoute({
		method: 'post',
		path: '/drafts/{draftId}/approve',
		operationId: 'core.approveDraft',
		summary: 'Approve (optionally edit) and apply a draft',
		// The runner decides who may: an approver, or the member a draft is addressed to.
		requires: CORE_CAPABILITIES.draftsPropose.id,
		params: DraftParams,
		body: z.object({ input: z.unknown().optional() }),
		response: DraftSchema,
		async handle(_ctx, { params, body, actor }) {
			return view(await deps.runner().approveDraft(params.draftId, actor, body.input), actor);
		},
	});

	const reject = defineRoute({
		method: 'post',
		path: '/drafts/{draftId}/reject',
		operationId: 'core.rejectDraft',
		summary: 'Reject a draft, or withdraw your own',
		requires: CORE_CAPABILITIES.draftsPropose.id,
		params: DraftParams,
		response: DraftSchema,
		async handle(_ctx, { params, actor }) {
			return view(await deps.runner().rejectDraft(params.draftId, actor), actor);
		},
	});

	const undo = defineRoute({
		method: 'post',
		path: '/drafts/{draftId}/undo',
		operationId: 'core.undoDraft',
		summary: "Take back an applied draft (Undo), with its action's inverse",
		requires: CORE_CAPABILITIES.draftsPropose.id,
		params: DraftParams,
		response: DraftSchema,
		async handle(_ctx, { params, actor }) {
			return view(await deps.runner().undoDraft(params.draftId, actor), actor);
		},
	});

	const suggestAgain = defineRoute({
		method: 'post',
		path: '/drafts/{draftId}/suggest-again',
		operationId: 'core.suggestDraftAgain',
		summary: 'Suggest an undone draft again, as a new waiting draft (only the person behind it)',
		requires: CORE_CAPABILITIES.draftsPropose.id,
		params: DraftParams,
		response: DraftSchema,
		async handle(_ctx, { params, actor }) {
			return view(await deps.runner().suggestAgain(params.draftId, actor), actor);
		},
	});

	const replace = defineRoute({
		method: 'post',
		path: '/drafts/{draftId}/replace',
		operationId: 'core.replaceDraft',
		summary: 'Turn a pending draft into the alternative it offers (`instead`)',
		// The runner decides who may: whoever may decide both the draft and what it becomes.
		requires: CORE_CAPABILITIES.draftsPropose.id,
		params: DraftParams,
		response: DraftSchema,
		async handle(_ctx, { params, actor }) {
			return view(await deps.runner().replaceDraft(params.draftId, actor), actor);
		},
	});

	return {
		listDrafts,
		countWaiting,
		decidableSources,
		editDraft,
		expireDrafts,
		approve,
		reject,
		undo,
		suggestAgain,
		replace,
	};
}
