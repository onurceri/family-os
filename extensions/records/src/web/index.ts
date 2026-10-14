import { defineWebExtension } from '@famos/ui/slots';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import { addObligationPresenter, completeObligationPresenter } from './presenters.js';

/**
 * Records UI: the sections ("What needs doing", "Papers") that domain pages render through the
 * `record.section` slot, and a Today card with what is coming up. Records has no page of its
 * own: the record pages belong to vehicles, pets and the home.
 */
export default defineWebExtension({
	manifest: pkg.famos,
	messages: en,
	labelKey: 'records:feature_name',
	descriptionKey: 'records:feature_description',
	slots: [
		{
			slot: 'record.section',
			id: 'records.obligations',
			order: 10,
			requires: 'records.view',
			component: () => import('./RecordObligations.svelte'),
		},
		{
			slot: 'record.section',
			id: 'records.papers',
			order: 20,
			requires: 'records.view',
			component: () => import('./RecordPapers.svelte'),
		},
		{
			slot: 'dashboard.card',
			id: 'records.overdue',
			band: 'needs',
			order: 40,
			component: () => import('./OverdueCard.svelte'),
		},
		{
			slot: 'dashboard.card',
			id: 'records.comingUp',
			band: 'ahead',
			labelKey: 'records:today_block',
			hintKey: 'records:today_block_hint',
			order: 40,
			component: () => import('./ComingUpCard.svelte'),
		},
		{
			slot: 'display.widget',
			id: 'records.comingUp',
			order: 40,
			requires: 'records.view',
			component: () => import('./DisplayComingUp.svelte'),
		},
	],
	drafts: [addObligationPresenter, completeObligationPresenter],
});
