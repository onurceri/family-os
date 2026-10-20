import {
	ApiDateSchema,
	ApiInstantSchema,
	apiId,
	apiInstant,
	apiOutput,
	defineApi,
} from '@famos/sdk';
import { z } from 'zod';
import { type BoardNote, NOTE_MAX_CHARS, NOTE_PAPERS } from '../contract/index.ts';

/** What the family board offers on the public API: the notes on it now, and putting one up. */
const MemberId = apiId('member');
const NoteId = apiId('board_note');

export const PublicNoteSchema = z
	.object({
		id: NoteId,
		version: z
			.number()
			.int()
			.describe('Counts every write; send it as `If-Match` to change only an unchanged note'),
		text: z.string().describe(`The note, at most ${NOTE_MAX_CHARS} characters`),
		paper: z.enum(NOTE_PAPERS).describe('The color of the paper'),
		pinned: z.boolean().describe('Pinned notes come first'),
		endsAt: ApiInstantSchema.nullable().describe(
			'When the note leaves the board; null when it stays',
		),
		endsOn: ApiDateSchema.nullable().describe('The last day it is on the board'),
		hasPhoto: z.boolean(),
		createdBy: MemberId.nullable().describe(
			'Who put it up; null for an app or a member who is gone',
		),
		createdAt: ApiInstantSchema,
		updatedAt: ApiInstantSchema,
		seenBy: z.array(MemberId).describe('The members who have seen it'),
	})
	.meta({ id: 'BoardNote' });

const projectNoteOf = (note: BoardNote, timeZone: string) => ({
	...note,
	endsAt: note.endsAt === null ? null : apiInstant(note.endsAt, timeZone),
	createdAt: apiInstant(note.createdAt, timeZone),
	updatedAt: apiInstant(note.updatedAt, timeZone),
});

export const api = {
	listNotes: defineApi({
		name: 'board.listNotes',
		method: 'get',
		path: '/notes',
		summary:
			'The notes on the board now: pinned first, then in the order the family arranged them (newest first for notes never moved)',
		output: apiOutput(z.array(PublicNoteSchema), (notes: BoardNote[], { timeZone }) =>
			notes.map((n) => projectNoteOf(n, timeZone)),
		),
	}),
	createNote: defineApi({
		name: 'board.createNote',
		method: 'post',
		path: '/notes',
		summary: 'Put a note on the board',
		describe: {
			pinned: 'Keeps the note at the top; only people who manage the board can',
			endsOn: 'The last day the note stays on the board; without it the note stays',
		},
		output: apiOutput(PublicNoteSchema, (note: BoardNote, { timeZone }) =>
			projectNoteOf(note, timeZone),
		),
	}),
	editNote: defineApi({
		name: 'board.editNote',
		method: 'patch',
		path: '/notes/{noteId}',
		params: { noteId: 'id' },
		summary:
			'Change the text, paper or last day of a note; what is left out stays. Only its author or someone who manages the board may',
		describe: {
			endsOn: 'The last day the note stays on the board; null lets it stay',
		},
		output: apiOutput(
			PublicNoteSchema,
			({ ok: _ok, ...note }: BoardNote & { ok: true }, { timeZone }) =>
				projectNoteOf(note, timeZone),
		),
	}),
	removeNote: defineApi({
		name: 'board.removeNote',
		method: 'delete',
		path: '/notes/{noteId}',
		params: { noteId: 'id' },
		summary: 'Take a note off the board. Only its author or someone who manages the board may',
		output: apiOutput(
			z
				.object({ removed: z.boolean().describe('False when the note was already gone') })
				.meta({ id: 'BoardNoteDeleted' }),
			(result: { removed: boolean }) => ({ removed: result.removed }),
		),
	}),
};
