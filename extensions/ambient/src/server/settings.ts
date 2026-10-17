import { defineAction, defineRoute, FamosError, storedAsWhole, type UnitOfWork } from '@famos/sdk';
import {
	type AmbientSettings,
	AmbientSettingsSchema,
	roundCoordinate,
	type StoredSettings,
	TimingSchema,
	UpdateTimingInputSchema,
	UpdateWeatherInputSchema,
} from '../contract/index.ts';
import { ambientManage, settingsChanged } from './capabilities.ts';
import { loadSettings, saveSettings } from './store.ts';

/** Settings as the API shows them. */
export function toView(settings: StoredSettings): AmbientSettings {
	return {
		weather: settings.weather,
		timing: settings.timing,
	};
}

async function update(
	uow: UnitOfWork,
	change: (current: StoredSettings) => StoredSettings,
): Promise<AmbientSettings> {
	const { settings, version } = await loadSettings(uow.db);
	const next = change(settings);
	await saveSettings(uow.db, next, version, uow.clock.now());
	uow.emit(settingsChanged, {});
	return toView(next);
}

export const updateWeather = defineAction({
	id: 'ambient.updateWeather',
	title: 'Turn the weather on displays on or off, and choose the place',
	input: UpdateWeatherInputSchema,
	output: AmbientSettingsSchema,
	requires: ambientManage.id,
	approval: 'never',
	run: (uow, input) => {
		if (input.enabled && !input.place)
			throw new FamosError('bad_request', 'Choose a place for the weather');
		const place = input.place && {
			name: input.place.name,
			latitude: roundCoordinate(input.place.latitude),
			longitude: roundCoordinate(input.place.longitude),
		};
		return update(uow, (current) => ({ ...current, weather: { enabled: input.enabled, place } }));
	},
});

export const updateTiming = defineAction({
	id: 'ambient.updateTiming',
	title: 'Set when displays switch to ambient mode and how long each photo stays',
	input: UpdateTimingInputSchema,
	// Waiting from when a field left out meant empty (or its default): read that way.
	storedInput: storedAsWhole(TimingSchema),
	output: AmbientSettingsSchema,
	requires: ambientManage.id,
	approval: 'never',
	run: (uow, input) => update(uow, (current) => ({ ...current, timing: input })),
});

export const getSettings = defineRoute({
	method: 'get',
	path: '/settings',
	operationId: 'ambient.getSettings',
	summary: 'Display content settings',
	requires: ambientManage.id,
	response: AmbientSettingsSchema,
	async handle(ctx) {
		return toView((await loadSettings(ctx.db)).settings);
	},
});
