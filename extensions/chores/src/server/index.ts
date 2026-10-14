import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import { choresEdit, choresUse, choresView } from './capabilities.ts';
import {
	archiveChore,
	createChore,
	getChore,
	listAllChores,
	listChores,
	markDone,
	setAssignees,
	undoDone,
	updateChore,
} from './chores.ts';
import { choreDueKind, remindJob } from './reminders.ts';
import { choresChanged } from './shared.ts';
import { migrations } from './store.ts';
import { getTodayByMember, todayByMemberAction } from './today.ts';

/**
 * Chores: shared household work that rotates fairly and is ticked off with one tap. The AI may
 * suggest chores and a fair split as drafts and read whose turn it is; it never touches
 * completions.
 */
export default defineExtension({
	manifest: pkg.famos,
	migrations,
	actions: [
		createChore,
		updateChore,
		archiveChore,
		setAssignees,
		markDone,
		undoDone,
		listChores,
		todayByMemberAction,
	],
	routes: [listAllChores, getChore, getTodayByMember],
	events: [choresChanged],
	capabilities: [choresView, choresUse, choresEdit],
	notifications: [choreDueKind],
	jobs: [remindJob],
});
