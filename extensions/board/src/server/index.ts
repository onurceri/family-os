import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import { boardChanged, boardManage, boardPost, boardView, postedKind } from './capabilities.ts';
import {
	aiListNotes,
	cleanupJob,
	deleteFileJob,
	editNote,
	getNotePhoto,
	getNotes,
	markSeen,
	moveNote,
	pinNote,
	postNote,
	removeNote,
	scheduleCleanup,
	setNotePhoto,
	uploadNotePhoto,
} from './notes.ts';
import { migrations } from './store.ts';

/**
 * The family board: short notes for everyone, on papers, with an optional photo, an
 * end date and a pin. No replies; the only reaction is "seen". Notes that ended are hidden at
 * once and deleted, with their photos, 30 days later by a daily job.
 */
export default defineExtension({
	manifest: pkg.famos,
	migrations,
	actions: [postNote, editNote, removeNote, pinNote, moveNote, markSeen, setNotePhoto, aiListNotes],
	routes: [getNotes, getNotePhoto, uploadNotePhoto],
	jobs: [deleteFileJob, cleanupJob],
	events: [boardChanged],
	capabilities: [boardView, boardPost, boardManage],
	notifications: [postedKind],
	async register(ctx) {
		await scheduleCleanup(ctx);
	},
});
