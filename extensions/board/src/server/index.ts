import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import { boardChanged, boardManage, boardPost, boardView, postedKind } from './capabilities.ts';
import {
	aiListNotes,
	boardDigest,
	cleanupJob,
	deleteFileJob,
	editNote,
	getNotePhoto,
	getNotes,
	markNotesSeen,
	moveNote,
	pinNote,
	postNote,
	removeNote,
	scheduleCleanup,
	setNotePhoto,
	uploadNotePhoto,
} from './notes.ts';
import { migrations } from './store.ts';
import { noteKind } from './understand.ts';

/**
 * The family board: short notes for everyone, on papers, with an optional photo, an
 * end date and a pin. No replies; the only reaction is "seen". Notes that ended are hidden at
 * once and deleted, with their photos, 30 days later by a daily job.
 */
export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	ai: { kinds: [noteKind] },
	actions: [
		postNote,
		editNote,
		removeNote,
		pinNote,
		moveNote,
		markNotesSeen,
		setNotePhoto,
		aiListNotes,
		boardDigest,
	],
	routes: [getNotes, getNotePhoto, uploadNotePhoto],
	jobs: [deleteFileJob, cleanupJob],
	events: [boardChanged],
	capabilities: [boardView, boardPost, boardManage],
	notifications: [postedKind],
	async register(ctx) {
		await scheduleCleanup(ctx);
	},
});
