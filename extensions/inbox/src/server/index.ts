import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import {
	addItem,
	createItem,
	dismissItem,
	fileItem,
	getItemFile,
	inboxShare,
	itemChanged,
	listItems,
	retryItem,
	shareTarget,
} from './items.ts';
import { itemReady, processItem } from './process.ts';
import { searchIndex } from './search.ts';
import { migrations } from './store.ts';

/** Family Inbox: shared things become AI-proposed drafts that someone approves. */
export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	ai: { index: searchIndex },
	actions: [addItem, retryItem, dismissItem, fileItem],
	routes: [createItem, listItems, getItemFile],
	jobs: [processItem],
	notifications: [itemReady],
	events: [itemChanged],
	capabilities: [inboxShare],
	shareTarget,
});
