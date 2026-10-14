import { defineWebExtension } from '@famos/ui/slots';
import { Sparkles } from '@lucide/svelte';
import { CHAT_FEATURE } from '../contract/index.js';

/**
 * Assistant UI: the Ask page, a rail entry (on phones it overflows into More)
 * and an "Ask" card on Today.
 */
export default defineWebExtension({
	id: 'assistant',
	labelKey: 'assistant:feature_name',
	descriptionKey: 'assistant:feature_description',
	aiFeatures: [
		{
			id: CHAT_FEATURE,
			labelKey: 'assistant:ai_feature_chat',
			hintKey: 'assistant:ai_feature_chat_hint',
		},
	],
	nav: [
		{
			id: 'assistant.nav',
			path: '/assistant',
			labelKey: 'assistant:nav',
			icon: Sparkles,
			placement: 'primary',
			order: 90,
			requires: 'assistant.use',
		},
	],
	slots: [
		{
			slot: 'dashboard.card',
			id: 'assistant.ask',
			labelKey: 'assistant:today_block',
			hintKey: 'assistant:today_block_hint',
			band: 'foot',
			order: 90,
			requires: 'assistant.use',
			component: () => import('./AskCard.svelte'),
		},
	],
	pages: [
		{ id: 'assistant.page', path: '/assistant', component: () => import('./AssistantPage.svelte') },
	],
});
