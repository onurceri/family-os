import { idSchema, wholeRecord } from '@famos/sdk';
import { IsoDateSchema, RecurrenceSchema } from '@famos/time';
import { z } from 'zod';

/**
 * Chores contract: shared household work that rotates fairly. Dates are local to the family time
 * zone (`YYYY-MM-DD`); timestamps are epoch milliseconds.
 */
export const ChoreIdSchema = idSchema('chore');
export const CompletionIdSchema = idSchema('chore_done');
export const MemberIdSchema = idSchema('member');

/** Capability ids, shared with the web UI. */
export const CHORES_VIEW = 'chores.view';
export const CHORES_USE = 'chores.use';
export const CHORES_EDIT = 'chores.edit';

/**
 * Who does a chore next:
 * - `fixed`: the same person every time;
 * - `round_robin`: the next person in the list after whoever did it;
 * - `least_done`: whoever did this chore the fewest times in the last 90 days.
 */
export const ROTATIONS = ['fixed', 'round_robin', 'least_done'] as const;
export const RotationSchema = z.enum(ROTATIONS);
export type Rotation = z.infer<typeof RotationSchema>;

/** How far back `least_done` counts. */
export const LEAST_DONE_DAYS = 90;

const MemberListSchema = z
	.array(MemberIdSchema)
	.max(20)
	.refine((ids) => new Set(ids).size === ids.length, 'A person can be listed once');

/** What a chore is, without who does it. */
export const ChoreDetailsSchema = z.object({
	title: z.string().trim().min(1).max(120).describe('The chore, e.g. "Empty the dishwasher"'),
	notes: z.string().trim().max(1000).nullable().optional(),
	recurrence: RecurrenceSchema.nullable()
		.optional()
		.describe('How it repeats; omit or null for a one-off chore'),
	startDate: IsoDateSchema.describe('The first day it is due, YYYY-MM-DD, in the family time zone'),
	rotation: RotationSchema.default('fixed').describe(
		'fixed: the same person; round_robin: take turns in the listed order; least_done: whoever did it least lately',
	),
});
export type ChoreDetails = z.input<typeof ChoreDetailsSchema>;

export const CreateChoreSchema = ChoreDetailsSchema.extend({
	assigneeIds: MemberListSchema.default([]).describe(
		'The people in turn order; the first one is up first. Empty means anyone',
	),
});
export type CreateChoreInput = z.input<typeof CreateChoreSchema>;

/** The whole chore as the form saves it: every field, null for one left empty. */
export const UpdateChoreSchema = z.object({
	id: ChoreIdSchema,
	chore: wholeRecord(ChoreDetailsSchema),
	onlyThisTurnOn: IsoDateSchema.optional().describe(
		'Moves only the turn that is up now to this day (YYYY-MM-DD); the repeat and the start stay as they are and the turn after it follows the repeat. Leave out to change the chore from now on',
	),
});
export type UpdateChoreInput = z.input<typeof UpdateChoreSchema>;

export const ChoreSchema = z.object({
	id: ChoreIdSchema,
	/** Counts every write of the chore and of the people in its rotation. */
	version: z.number().int(),
	title: z.string(),
	notes: z.string().nullable(),
	recurrence: RecurrenceSchema.nullable(),
	startDate: z.string(),
	/** The day it is due next; null once a one-off chore is done. */
	nextDue: z.string().nullable(),
	overdue: z.boolean(),
	rotation: RotationSchema,
	/** Who is up now; null means anyone. */
	assigneeId: z.string().nullable(),
	/** The people in rotation order. */
	assigneeIds: z.array(z.string()),
	/** The latest completion still standing; `id` lets its doer take it back (`chores.undoDone`). */
	lastDone: z.object({ id: z.string(), memberId: z.string(), doneAt: z.number() }).nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type Chore = z.infer<typeof ChoreSchema>;

export const SetAssigneesSchema = z.object({
	id: ChoreIdSchema,
	memberIds: MemberListSchema.describe('The people in turn order; empty means anyone'),
	/** The chore's title as listed, so a reviewer reads which chore a proposal is about. */
	choreTitle: z.string().trim().max(120).optional(),
});
export const SetAssigneesResultSchema = z.object({
	chore: ChoreSchema,
	previousAssigneeIds: z.array(z.string()),
});

export const MarkDoneSchema = z.object({
	id: ChoreIdSchema,
	/** The due date the caller saw; a stale tap (already done) changes nothing. */
	dueDate: IsoDateSchema,
	/** Who did it (default: the person tapping). Someone else needs `chores.edit`. */
	doneBy: MemberIdSchema.optional(),
	/** Only for people reviewing a suggestion: which chore it is. Never stored. */
	label: z
		.string()
		.trim()
		.max(200)
		.optional()
		.describe('The chore as listed, e.g. "Empty the dishwasher"; only shown to the reviewer'),
});

/** A completion as the chore's history shows it: who and when. */
export const CompletionSchema = z.object({
	id: CompletionIdSchema,
	choreId: ChoreIdSchema,
	memberId: z.string(),
	dueDate: z.string(),
	doneAt: z.number(),
});
export type Completion = z.infer<typeof CompletionSchema>;

export const MarkDoneResultSchema = z.object({
	chore: ChoreSchema,
	/** Null when the tap changed nothing; `reason` then says why. */
	completion: CompletionSchema.nullable(),
	/**
	 * Set when nothing changed: `already_done` for a date that was done already, `stale` when the
	 * chore has moved on to another due date.
	 */
	reason: z.enum(['stale', 'already_done']).optional(),
});
export type MarkDoneResult = z.infer<typeof MarkDoneResultSchema>;

export const UndoDoneSchema = z.object({ completionId: CompletionIdSchema });

export const ChoreDetailSchema = ChoreSchema.extend({
	history: z.array(CompletionSchema.extend({ undoneAt: z.number().nullable() })),
});
export type ChoreDetail = z.infer<typeof ChoreDetailSchema>;

export const OkSchema = z.object({ ok: z.literal(true) });

export const choreChangedPayload = z.object({
	choreId: z.string().optional(),
	/** `delete`: the chore is gone for readers (archived). */
	op: z.enum(['upsert', 'delete']).optional(),
});

/**
 * Today's chores for one person, or for anyone (`memberId: null`): what was due today or is late
 * (`total`) and how much of it is done (`done`). A completion of today counts for whoever's turn it
 * was, so a ring per person stays whole after a tap.
 */
export const TodayChoresSchema = z.object({
	memberId: z.string().nullable(),
	done: z.number().int().min(0),
	total: z.number().int().min(0),
});
export type TodayChores = z.infer<typeof TodayChoresSchema>;
export const TodayByMemberSchema = z.array(TodayChoresSchema);

/** Where the app opens a chore. */
export const choreHref = (choreId: string) => `/chores/${choreId}`;
