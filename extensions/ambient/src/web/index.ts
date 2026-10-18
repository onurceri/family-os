import { defineWebExtension } from '@famos/ui/slots';
import { Images } from '@lucide/svelte';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import { photoFacet, placeStep, SETTINGS_PATH, weatherFacet } from './today.js';

/**
 * Ambient UI: the Photos and weather settings page, the weather of Today (and of a display's
 * Today), the photo of the day, the place among a new family's first steps and ambient mode of
 * family displays. Ambient mode is a `display.ambient` contribution: the display page only offers
 * the place, this extension decides when to show itself.
 */
export default defineWebExtension({
	manifest: pkg.famos,
	messages: en,
	labelKey: 'ambient:feature_name',
	descriptionKey: 'ambient:feature_description',
	nav: [
		{
			id: 'ambient.photosWeather',
			path: SETTINGS_PATH,
			labelKey: 'ambient:nav_photos_weather',
			icon: Images,
			placement: 'more',
			group: 'settings',
			section: 'family',
			// After Devices and displays.
			order: 35,
			requires: 'ambient.manage',
		},
	],
	pages: [
		{
			id: 'ambient.settings',
			requires: 'ambient.manage',
			path: SETTINGS_PATH,
			component: () => import('./PhotosWeatherPage.svelte'),
		},
	],
	slots: [
		{
			slot: 'settings.display',
			id: 'ambient.content',
			order: 10,
			requires: 'ambient.manage',
			component: () => import('./DisplaysLink.svelte'),
		},
		{
			slot: 'setup.step',
			id: 'ambient.place',
			order: 10,
			requires: 'ambient.manage',
			component: () => import('./SetupPlaceStep.svelte'),
		},
		{
			slot: 'today.atmosphere',
			id: 'ambient.atmosphere',
			order: 1,
			requires: 'ambient.weather',
			component: () => import('./AtmosphereLine.svelte'),
		},
		{
			slot: 'display.ambient',
			id: 'ambient.mode',
			requires: 'ambient.photos',
			component: () => import('./Ambient.svelte'),
		},
		{
			// The photos as a screen of their own between Today's turns on a family display.
			slot: 'display.page',
			id: 'ambient.photos',
			labelKey: 'ambient:display_photos',
			requires: 'ambient.photos',
			component: () => import('./PhotosPage.svelte'),
		},
	],
	today: [photoFacet, weatherFacet, placeStep],
});
