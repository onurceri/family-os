import { unwrap } from '@famos/api-client';
import { defineWebExtension } from '@famos/ui/slots';
import { SquarePlus } from '@lucide/svelte';
import pkg from '../../package.json' with { type: 'json' };
import { EXTRACT_FEATURE, TRANSCRIBE_FEATURE } from '../contract/index.js';
import en from '../messages/en.json' with { type: 'json' };
import { api } from './api.js';

/** Quick add UI: the Quick add tab (with the count waiting), its global button and the share target page. */
export default defineWebExtension({
	manifest: pkg.famos,
	messages: en,
	labelKey: 'inbox:feature_name',
	descriptionKey: 'inbox:feature_description',
	aiFeatures: [
		{
			id: EXTRACT_FEATURE,
			labelKey: 'inbox:ai_feature_extract',
			hintKey: 'inbox:ai_feature_extract_hint',
		},
		{
			id: TRANSCRIBE_FEATURE,
			labelKey: 'inbox:ai_feature_transcribe',
			hintKey: 'inbox:ai_feature_transcribe_hint',
		},
	],
	nav: [
		{
			id: 'inbox.nav',
			path: '/add',
			labelKey: 'inbox:nav',
			icon: SquarePlus,
			placement: 'primary',
			order: 10,
			requires: 'inbox.share',
			// Where things are shared with the family: Today links here and `n` opens Quick add.
			share: true,
			// Suggestions waiting for this person: theirs alone, and those they may decide.
			badge: async () => unwrap(await api.GET('/api/v1/core/drafts/waiting')).count,
		},
	],
	slots: [
		{
			slot: 'nav.action',
			id: 'inbox.quickAdd',
			order: 0,
			requires: 'inbox.share',
			component: () => import('./QuickAddPanel.svelte'),
		},
		{
			slot: 'dashboard.card',
			id: 'inbox.waiting',
			band: 'needs',
			order: 0,
			component: () => import('./InboxCard.svelte'),
		},
		{
			slot: 'today.capture',
			id: 'inbox.capture',
			requires: 'inbox.share',
			component: () => import('./TodayCapture.svelte'),
		},
		{
			slot: 'display.status',
			id: 'inbox.waiting',
			order: 10,
			requires: 'core.drafts.waiting',
			component: () => import('./DisplayWaiting.svelte'),
		},
	],
	pages: [
		{
			id: 'inbox.page',
			requires: 'inbox.share',
			path: '/add',
			component: () => import('./QuickAddPage.svelte'),
		},
		{
			id: 'inbox.share',
			requires: 'inbox.share',
			path: '/share',
			component: () => import('./SharePage.svelte'),
		},
	],
});
