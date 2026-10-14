import { unwrap } from '@famos/api-client';
import { sharedRead } from '@famos/ui/famos';
import type {
	AmbientSettings,
	LibraryPhoto,
	PhotoList,
	PlaceResult,
	Weather,
} from '../contract/index.js';
import { api } from './api.js';

/** Ambient API calls, all through the generated client. */
export const loadPhotos = async (): Promise<PhotoList> =>
	unwrap(await api.GET('/api/v1/ambient/photos'));

/** Shared by everything that opens together (Today's weather and its setup steps). */
export const loadWeather = (): Promise<Weather> =>
	sharedRead('/api/v1/ambient/weather', async () =>
		unwrap(await api.GET('/api/v1/ambient/weather')),
	);

export const photoUrl = (id: string) => `/api/v1/ambient/photos/${encodeURIComponent(id)}`;

/** The photo of the day (same month, another year), or null when there is none. */
export const loadPhotoOfToday = async (): Promise<{ id: string; month: string } | null> =>
	unwrap(await api.GET('/api/v1/ambient/photos/today')).photo;

export const loadSettings = async (): Promise<AmbientSettings> =>
	unwrap(await api.GET('/api/v1/ambient/settings'));

export const loadLibrary = async (): Promise<LibraryPhoto[]> =>
	unwrap(await api.GET('/api/v1/ambient/library'));

export const searchPlaces = async (q: string): Promise<PlaceResult[]> =>
	unwrap(await api.GET('/api/v1/ambient/places', { params: { query: { q } } }));

type Result = { data?: unknown; error?: unknown; response: Response };

/** Runs an action that is always applied (managers only; no approval) and returns its output. */
async function act<T>(request: Promise<Result>): Promise<T> {
	const result = unwrap(await request) as { status: string; output?: T };
	if (result.status !== 'applied') throw new Error('The change was not applied');
	return result.output as T;
}

export async function uploadPhoto(photo: Blob, name: string): Promise<void> {
	unwrap(
		await api.POST('/api/v1/ambient/photos', {
			body: {},
			bodySerializer: () => {
				const form = new FormData();
				form.append('files', photo, name);
				return form;
			},
		}),
	);
}

export const deletePhoto = (id: string) =>
	act<{ removed: boolean }>(api.POST('/api/v1/actions/ambient.deletePhoto', { body: { id } }));

export const saveWeather = (input: AmbientSettings['weather']) =>
	act<AmbientSettings>(api.POST('/api/v1/actions/ambient.updateWeather', { body: input }));

export const saveTiming = (input: AmbientSettings['timing']) =>
	act<AmbientSettings>(api.POST('/api/v1/actions/ambient.updateTiming', { body: input }));
