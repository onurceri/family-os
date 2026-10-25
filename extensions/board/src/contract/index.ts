import { idSchema } from '@famos/sdk';
import { IsoDateSchema } from '@famos/time';
import { z } from 'zod';

/**
 * Board contract: short notes for the whole family. A note has text, one of five
 * papers, an optional photo and end date, and can be pinned. There are no replies or threads;
 * the only reaction is "seen".
 */
export const NoteIdSchema = idSchema('board_note');
export const MemberIdSchema = idSchema('member');

export const NOTE_MAX_CHARS = 500;
export const NOTE_PAPERS = ['note-1', 'note-2', 'note-3', 'note-4', 'note-5'] as const;
export const PaperSchema = z.enum(NOTE_PAPERS);
export type Paper = z.infer<typeof PaperSchema>;

/** The capabilities of the board; the web asks for them by these names. */
export const BOARD_VIEW = 'board.view';
export const BOARD_POST = 'board.post';
export const BOARD_MANAGE = 'board.manage';

/** Notes stay in the database this long after they ended, then they and their photos go. */
export const KEEP_AFTER_END_DAYS = 30;

const TextSchema = z
	.string()
	.trim()
	.min(1)
	.max(NOTE_MAX_CHARS)
	.describe("The note, in the family's own words (at most 500 characters); line breaks are kept");

export const PostNoteSchema = z.object({
	text: TextSchema,
	paper: PaperSchema.default('note-1').describe('The color of the paper, note-1 … note-5'),
	pinned: z
		.boolean()
		.optional()
		.describe('Keeps the note at the top; only people who manage the board can; leave it out'),
	endsOn: IsoDateSchema.optional().describe(
		'The last day the note stays on the board (YYYY-MM-DD, family time); leave out to keep it',
	),
});
export type PostNoteInput = z.input<typeof PostNoteSchema>;

export const EditNoteSchema = z.object({
	id: NoteIdSchema,
	text: TextSchema.optional(),
	paper: PaperSchema.optional(),
	/** A date sets the last day, `null` takes the end date away. */
	endsOn: IsoDateSchema.nullable().optional(),
});
export type EditNoteInput = z.input<typeof EditNoteSchema>;

/**
 * Moves a note among the notes of its own group (pinned notes stay first): just before `before`,
 * or just after `after`. Give one of them; with both, `before` wins.
 */
export const MoveNoteSchema = z
	.object({
		id: NoteIdSchema,
		before: NoteIdSchema.optional().describe(
			'The id of the note it should come just before: a note on the board that is pinned when this one is, and not pinned when this one is not',
		),
		after: NoteIdSchema.optional().describe(
			'The id of the note it should come just after (same rule as before); give before or after, not both',
		),
	})
	.refine((v) => (v.before === undefined) !== (v.after === undefined), {
		message:
			'Say where the note goes: give the id of one other note as before or as after, not both',
	});
export type MoveNoteInput = z.input<typeof MoveNoteSchema>;

export const BoardNoteSchema = z.object({
	id: z.string(),
	/** Counts every write of the note and of who has seen it. */
	version: z.number().int(),
	text: z.string(),
	paper: PaperSchema,
	pinned: z.boolean(),
	/** The instant the note leaves the board (the end of its last day in family time). */
	endsAt: z.number().nullable(),
	/** The last day, `YYYY-MM-DD` in family time. */
	endsOn: z.string().nullable(),
	hasPhoto: z.boolean(),
	/** Who put it up; null when the member is gone or it was not a person. */
	createdBy: z.string().nullable(),
	/** The connected app that put it up on its own (then `createdBy` is null); null otherwise. */
	createdByApp: z.object({ id: z.string(), name: z.string() }).nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
	/** The members who have seen it, the author included. */
	seenBy: z.array(z.string()),
});
export type BoardNote = z.infer<typeof BoardNoteSchema>;

export const boardChangedPayload = z.object({
	noteId: z.string().optional(),
	/** Several notes changed together (marked seen); each is logged as changed. */
	noteIds: z.array(z.string()).optional(),
	/** `delete`: the note is gone for readers. */
	op: z.enum(['upsert', 'delete']).optional(),
});
