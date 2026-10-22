import type { PhotoFacet, SetupHintFacet, WeatherFacet } from '@famos/ui/slots';
import { loadPhotoOfToday, loadWeather, photoUrl } from './data.js';

/** Settings, Photos and weather: where the place, the photos and the slideshow are chosen. */
export const SETTINGS_PATH = '/settings/photos-weather';

/** Settings, Photos and weather with the place panel already open (what "Set your city" is for). */
export const PLACE_PATH = `${SETTINGS_PATH}?place=1`;

/** The photo of the day on Today (and a display's Today). */
export const photoFacet: PhotoFacet = {
	kind: 'photo',
	id: 'ambient.photo',
	requires: 'ambient.photos',
	invalidateOn: ['ambient.'],
	load: async () => {
		const photo = await loadPhotoOfToday();
		return photo ? { src: photoUrl(photo.id), month: photo.month } : null;
	},
};

/** The next hours, for a style that draws them on its own time axis (Lanes' weather row). */
export const weatherFacet: WeatherFacet = {
	kind: 'weather',
	id: 'ambient.hours',
	requires: 'ambient.weather',
	invalidateOn: ['ambient.'],
	refreshMs: 10 * 60_000,
	load: async () => {
		const weather = await loadWeather();
		const f = weather.enabled ? weather.forecast : null;
		return f ? { hours: f.hourly ?? [], min: f.min, max: f.max } : null;
	},
};

/** "Set your city", among a new family's first steps, for those who may set it. */
export const placeStep: SetupHintFacet = {
	kind: 'setupHint',
	id: 'ambient.place',
	requires: 'ambient.manage',
	order: 20,
	titleKey: 'ambient:setup_step',
	textKey: 'ambient:setup_step_text',
	actionKey: 'ambient:setup_step_action',
	href: PLACE_PATH,
	load: async () => (await loadWeather()).enabled,
};
