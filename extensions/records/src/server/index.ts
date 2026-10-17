import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import { recordsEdit, recordsView } from './capabilities.ts';
import {
	attachDocument,
	detachDocument,
	documentChanged,
	getDocumentFile,
	listDocuments,
	updateDocument,
} from './documents.ts';
import {
	addObligation,
	aiContext,
	archiveForRecord,
	completeObligation,
	getObligationHistory,
	listObligations,
	listUpcoming,
	obligationChanged,
	removeObligation,
	renameRecord,
	undoCompletion,
	upcoming,
	updateObligation,
} from './obligations.ts';
import { obligationDueKind, remindJob } from './reminders.ts';
import { searchIndex } from './search.ts';
import { migrations } from './store.ts';
import { dutyDoneKind, dutyKind } from './understand.ts';

/**
 * Records: obligations (duties that come back, with reminders) and papers for any record a
 * domain extension owns (vehicles, pets, the home). Domains talk to it only through these
 * actions and routes.
 */
export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	ai: { context: aiContext.id, index: searchIndex, kinds: [dutyKind, dutyDoneKind] },
	actions: [
		aiContext,
		upcoming,
		addObligation,
		updateObligation,
		completeObligation,
		undoCompletion,
		removeObligation,
		archiveForRecord,
		renameRecord,
		attachDocument,
		updateDocument,
		detachDocument,
	],
	routes: [listObligations, getObligationHistory, listUpcoming, listDocuments, getDocumentFile],
	events: [obligationChanged, documentChanged],
	capabilities: [recordsView, recordsEdit],
	notifications: [obligationDueKind],
	jobs: [remindJob],
});
