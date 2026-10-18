import { defineWebExtension } from '@famos/ui/slots';
import { StickyNote } from '@lucide/svelte';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import { postNotePresenter } from './presenters.js';

/**
 * Board UI: the board page (`/board`), a Today card with the latest notes and a
 * display widget. The board is for everyone every day, so it has a place in the rail on wide
 * screens; on a phone the three tabs are taken and it moves into More.
 */
export default defineWebExtension({
	manifest: pkg.famos,
	messages: en,
	labelKey: 'board:feature_name',
	descriptionKey: 'board:feature_description',
	drafts: [postNotePresenter],
	nav: [
		{
			id: 'board.nav',
			path: '/board',
			labelKey: 'board:nav',
			icon: StickyNote,
			placement: 'primary',
			group: 'household',
			order: 40,
			requires: 'board.view',
		},
	],
	pages: [
		{
			id: 'board.page',
			requires: 'board.view',
			path: '/board',
			component: () => import('./BoardPage.svelte'),
		},
	],
	slots: [
		{
			slot: 'dashboard.card',
			id: 'board.today',
			labelKey: 'board:today_block',
			hintKey: 'board:today_block_hint',
			band: 'notes',
			order: 5,
			requires: 'board.view',
			component: () => import('./BoardCard.svelte'),
		},
		{
			slot: 'display.widget',
			id: 'board.notes',
			labelKey: 'board:today_block',
			order: 15,
			requires: 'board.view',
			component: () => import('./DisplayBoard.svelte'),
		},
		{
			// The board on a screen of its own between Today's turns on a family display.
			slot: 'display.page',
			id: 'board.notes',
			labelKey: 'board:display_title',
			requires: 'board.view',
			component: () => import('./DisplayBoardPage.svelte'),
		},
	],
});
