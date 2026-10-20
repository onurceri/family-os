import {
	ApiDateSchema,
	ApiInstantSchema,
	apiId,
	apiInstant,
	apiOutput,
	defineApi,
} from '@famos/sdk';
import { RecurrenceSchema } from '@famos/time';
import { z } from 'zod';
import { type Chore, type ChoreDetail, type MarkDoneResult, ROTATIONS } from '../contract/index.ts';

/**
 * What the chores offer on the public API: the chores with whose turn it is and when each is due
 * (`nextDue`, and `overdue` once that day has passed), marking one done for the due date the
 * caller saw, and taking a completion back.
 */
const MemberId = apiId('member');
const ChoreId = apiId('chore');
const CompletionId = apiId('chore_done');

const PublicCompletionSchema = z
	.object({
		id: CompletionId,
		choreId: ChoreId,
		memberId: MemberId,
		dueDate: ApiDateSchema.describe('The due date it was done for'),
		doneAt: ApiInstantSchema,
		undoneAt: ApiInstantSchema.nullable().describe('When it was taken back; null while it stands'),
	})
	.meta({ id: 'ChoreCompletion' });

export const PublicChoreSchema = z
	.object({
		id: ChoreId,
		version: z
			.number()
			.int()
			.describe('Counts every write; send it as `If-Match` to change only an unchanged chore'),
		title: z.string(),
		notes: z.string().nullable(),
		recurrence: RecurrenceSchema.nullable().describe('How it repeats; null for a one-off chore'),
		startDate: ApiDateSchema,
		nextDue: ApiDateSchema.nullable().describe(
			'The day it is due next; null once a one-off chore is done',
		),
		overdue: z.boolean().describe('True once `nextDue` is before today'),
		rotation: z.enum(ROTATIONS).describe('How the turn passes on after it is done'),
		assigneeId: MemberId.nullable().describe('Whose turn it is; null means anyone'),
		assigneeIds: z.array(MemberId).describe('The people in turn order'),
		lastDone: z
			.object({ id: CompletionId, memberId: MemberId, doneAt: ApiInstantSchema })
			.nullable()
			.describe('The latest completion still standing; its `id` takes it back'),
		createdAt: ApiInstantSchema,
		updatedAt: ApiInstantSchema,
	})
	.meta({ id: 'Chore' });

export const PublicChoreDetailSchema = PublicChoreSchema.extend({
	history: z.array(PublicCompletionSchema).describe('Who did it lately, newest first'),
}).meta({ id: 'ChoreDetail' });

function projectChoreOf(chore: Chore, timeZone: string) {
	return {
		...chore,
		lastDone:
			chore.lastDone === null
				? null
				: { ...chore.lastDone, doneAt: apiInstant(chore.lastDone.doneAt, timeZone) },
		createdAt: apiInstant(chore.createdAt, timeZone),
		updatedAt: apiInstant(chore.updatedAt, timeZone),
	};
}

const projectChore = apiOutput(PublicChoreSchema, (chore: Chore, { timeZone }) =>
	projectChoreOf(chore, timeZone),
);

export const api = {
	listChores: defineApi({
		name: 'chores.listChores',
		method: 'get',
		path: '/',
		summary:
			'The chores with whose turn it is, soonest first. A chore is due on its `nextDue` and late once `overdue` is true',
		output: apiOutput(z.array(PublicChoreSchema), (chores: Chore[], { timeZone }) =>
			chores.map((c) => projectChoreOf(c, timeZone)),
		),
	}),
	getChore: defineApi({
		name: 'chores.getChore',
		method: 'get',
		path: '/{choreId}',
		summary: 'One chore with who did it lately',
		output: apiOutput(PublicChoreDetailSchema, (chore: ChoreDetail, { timeZone }) => ({
			...projectChoreOf(chore, timeZone),
			history: chore.history.map((h) => ({
				...h,
				doneAt: apiInstant(h.doneAt, timeZone),
				undoneAt: h.undoneAt === null ? null : apiInstant(h.undoneAt, timeZone),
			})),
		})),
	}),
	completeChore: defineApi({
		name: 'chores.completeChore',
		method: 'post',
		path: '/{choreId}/complete',
		params: { choreId: 'id' },
		omit: ['label'],
		summary:
			'Mark a chore done for the due date you saw. It moves to its next due date and the turn passes on; a date already done, or one the chore has moved past, changes nothing',
		describe: {
			dueDate: 'The `nextDue` you saw',
			doneBy:
				'Who did it; without it, the person the app acts for. Someone else needs permission to edit chores',
		},
		output: apiOutput(
			z
				.object({
					chore: PublicChoreSchema,
					completion: PublicCompletionSchema.nullable().describe('Null when nothing changed'),
					reason: z
						.enum(['stale', 'already_done'])
						.optional()
						.describe(
							'When nothing changed: `already_done` for a date done already, `stale` for a chore that has moved on to another date',
						),
				})
				.meta({ id: 'ChoreCompleted' }),
			(result: MarkDoneResult, { timeZone }) => ({
				chore: projectChoreOf(result.chore, timeZone),
				completion:
					result.completion === null
						? null
						: {
								...result.completion,
								doneAt: apiInstant(result.completion.doneAt, timeZone),
								undoneAt: null,
							},
				...(result.reason !== undefined && { reason: result.reason }),
			}),
		),
	}),
	undoCompletion: defineApi({
		name: 'chores.undoCompletion',
		method: 'post',
		path: '/completions/{completionId}/undo',
		summary:
			'Take a completion back: the due date and whose turn it was return. Your own completion of today, or any with permission to edit chores',
		output: projectChore,
	}),
};
