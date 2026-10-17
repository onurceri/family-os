import { defineWebExtension } from '@famos/ui/slots';
import { House, MapPin } from '@lucide/svelte';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import { presenceBlock, presenceToday } from './today.js';

const SETTINGS_PATH = '/settings/home-assistant';
const MINE_PATH = '/settings/home-assistant/me';

/**
 * Home Assistant UI: the connection, what to show and who is which person, in Settings → Family;
 * each person's own choice of what is shown about where they are, in Settings → You; the values
 * and who is home on Today and on displays.
 */
export default defineWebExtension({
	manifest: pkg.famos,
	messages: en,
	labelKey: 'homeassistant:feature_name',
	descriptionKey: 'homeassistant:feature_description',
	nav: [
		{
			id: 'homeassistant.connection',
			path: SETTINGS_PATH,
			labelKey: 'homeassistant:nav_label',
			icon: House,
			placement: 'more',
			group: 'settings',
			section: 'family',
			// After Photos and weather.
			order: 40,
			requires: 'homeassistant.manage',
		},
		{
			id: 'homeassistant.mine',
			path: MINE_PATH,
			labelKey: 'homeassistant:nav_label_mine',
			icon: MapPin,
			placement: 'more',
			group: 'settings',
			section: 'you',
			// After Calendar on my phone.
			order: 60,
			// Everyone's own choice, as their language is; the page says when they are not linked.
			requires: 'core.notifications.receive',
		},
	],
	slots: [
		{
			slot: 'dashboard.card',
			id: 'homeassistant.values',
			labelKey: 'homeassistant:today_block',
			hintKey: 'homeassistant:today_block_hint',
			band: 'notes',
			order: 20,
			requires: 'homeassistant.view',
			component: () => import('./ValuesCard.svelte'),
		},
		{
			slot: 'display.widget',
			id: 'homeassistant.values',
			order: 25,
			requires: 'homeassistant.view',
			component: () => import('./DisplayValues.svelte'),
		},
	],
	blocks: [presenceBlock],
	today: [presenceToday],
	pages: [
		{
			id: 'homeassistant.settings',
			requires: 'homeassistant.manage',
			path: SETTINGS_PATH,
			component: () => import('./ConnectionPage.svelte'),
		},
		{
			id: 'homeassistant.mine',
			requires: 'core.notifications.receive',
			path: MINE_PATH,
			component: () => import('./MySharingPage.svelte'),
		},
	],
});
