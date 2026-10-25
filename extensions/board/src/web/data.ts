import { unwrap } from '@famos/api-client';
import type { BoardNote, Paper, PostNoteInput } from '../contract/index.js';
import { api } from './api.js';
import type { Place } from './order.js';

/** Board API calls, all through the generated client. */
export const loadNotes = async (): Promise<BoardNote[]> =>
	unwrap(await api.GET('/api/v1/board/notes'));

export const notePhotoUrl = (noteId: string, version: number) =>
	`/api/v1/board/notes/${noteId}/photo?v=${version}`;

/** Puts a note up; resolves with its id, or null when it was only proposed. */
export async function postNote(input: PostNoteInput): Promise<string | null> {
	const result = unwrap(await api.POST('/api/v1/actions/board.postNote', { body: input }));
	return result.status === 'applied' ? result.output.id : null;
}

export const editNote = async (input: {
	id: string;
	text?: string;
	paper?: Paper;
	/** A date sets the last day, `null` takes it away. */
	endsOn?: string | null;
}): Promise<void> => {
	unwrap(await api.POST('/api/v1/actions/board.editNote', { body: input }));
};

export const removeNote = async (id: string): Promise<void> => {
	unwrap(await api.POST('/api/v1/actions/board.removeNote', { body: { id } }));
};

export const pinNote = async (id: string, pinned: boolean): Promise<void> => {
	unwrap(await api.POST('/api/v1/actions/board.pinNote', { body: { id, pinned } }));
};

/** Moves a note just before or just after another one of its group. */
export const moveNote = async (id: string, place: Place): Promise<void> => {
	unwrap(await api.POST('/api/v1/actions/board.moveNote', { body: { id, ...place } }));
};

/** Notes one call may mark (the server's limit). */
const MARK_SEEN_MAX = 100;

export const markSeen = async (ids: readonly string[]): Promise<void> => {
	for (let i = 0; i < ids.length; i += MARK_SEEN_MAX)
		unwrap(
			await api.POST('/api/v1/actions/board.markNotesSeen', {
				body: { ids: ids.slice(i, i + MARK_SEEN_MAX) },
			}),
		);
};

export async function uploadPhoto(noteId: string, photo: Blob): Promise<void> {
	unwrap(
		await api.POST('/api/v1/board/notes/{noteId}/photo', {
			params: { path: { noteId } },
			body: {},
			bodySerializer: () => {
				const form = new FormData();
				form.append('files', photo, 'photo.jpg');
				return form;
			},
		}),
	);
}
