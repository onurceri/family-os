import { defineCapability, defineEvent } from '@famos/sdk';
import { settingsChangedPayload } from '../contract/index.ts';

/** What display content protects. The two view capabilities can be given to displays. */
export const ambientPhotos = defineCapability({
	id: 'ambient.photos',
	label: 'ambient:cap_photos',
	level: 'view',
});
export const ambientWeather = defineCapability({
	id: 'ambient.weather',
	label: 'ambient:cap_weather',
	level: 'view',
});
export const ambientManage = defineCapability({
	id: 'ambient.manage',
	label: 'ambient:cap_manage',
	level: 'manage',
});

export const settingsChanged = defineEvent('ambient.settings.changed', settingsChangedPayload, {
	audience: ['ambient.photos', 'ambient.weather', 'ambient.manage'],
});
