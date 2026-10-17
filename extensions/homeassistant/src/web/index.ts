import { defineWebExtension } from '@famos/ui/slots';
import { House } from '@lucide/svelte';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

const SETTINGS_PATH = '/settings/home-assistant';

/** Home Assistant UI: the connection, in Settings → Family. */
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
	],
	pages: [
		{
			id: 'homeassistant.settings',
			path: SETTINGS_PATH,
			component: () => import('./ConnectionPage.svelte'),
		},
	],
});
