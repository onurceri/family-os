import { defineWebExtension } from '@famos/ui/slots';
import { SquareCheckBig } from '@lucide/svelte';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import {
	archiveChorePresenter,
	createChorePresenter,
	markDonePresenter,
	setAssigneesPresenter,
} from './presenters.js';
import { choresBlock, choresToday } from './today.js';

/**
 * Chores UI: the Chores page (today, overdue, upcoming, one tap to tick off), today's chores per
 * person on Today (rings, bars, a block of its own) and Inbox presenters for suggested chores and
 * splits.
 */
export default defineWebExtension({
	manifest: pkg.famos,
	messages: en,
	labelKey: 'chores:feature_name',
	descriptionKey: 'chores:feature_description',
	offlineReads: ['/chores'],
	nav: [
		{
			id: 'chores.nav',
			path: '/chores',
			labelKey: 'chores:nav',
			icon: SquareCheckBig,
			placement: 'more',
			group: 'household',
			order: 5,
			requires: 'chores.view',
		},
	],
	pages: [
		{
			id: 'chores.page',
			requires: 'chores.view',
			path: '/chores',
			component: () => import('./ChoresPage.svelte'),
		},
		// A chore opened in the detail pane (a link opens the same chore).
		{
			id: 'chores.chore',
			requires: 'chores.view',
			path: '/chores/:id',
			component: () => import('./ChoresPage.svelte'),
		},
	],
	slots: [
		{
			slot: 'dashboard.card',
			id: 'chores.today',
			band: 'notes',
			order: 25,
			glance: true,
			block: choresBlock.id,
			requires: 'chores.use',
			component: () => import('./ChoresCard.svelte'),
		},
	],
	blocks: [choresBlock],
	today: [choresToday],
	drafts: [createChorePresenter, setAssigneesPresenter, markDonePresenter, archiveChorePresenter],
});
