import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import { ambientManage, ambientPhotos, ambientWeather, settingsChanged } from './capabilities.ts';
import { getPhotoOfTheDay } from './photo-of-the-day.ts';
import {
	addPhoto,
	deleteFileJob,
	deletePhoto,
	getPhoto,
	listLibrary,
	listPhotos,
	uploadPhoto,
} from './photos.ts';
import { getSettings, updateTiming, updateWeather } from './settings.ts';
import { migrations } from './store.ts';
import { getWeather, searchPlaces } from './weather.ts';

/**
 * Ambient extension: what a family display shows when nobody uses it.
 * Photos are images the family uploaded (stored here, served to displays that may see them);
 * weather from Open-Meteo is fetched and cached by the server, so a display never calls anything
 * outside. Turning the extension off in Settings → Features stops every outbound call.
 */
export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	actions: [addPhoto, deletePhoto, updateWeather, updateTiming],
	jobs: [deleteFileJob],
	// `/photos/today` before `/photos/{photoId}`: routes match in this order.
	routes: [
		getSettings,
		listLibrary,
		uploadPhoto,
		listPhotos,
		getPhotoOfTheDay,
		getPhoto,
		getWeather,
		searchPlaces,
	],
	events: [settingsChanged],
	capabilities: [ambientPhotos, ambientWeather, ambientManage],
});
