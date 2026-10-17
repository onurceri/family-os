import { unwrap } from '@famos/api-client';
import type { Connection } from '../contract/index.js';
import { api } from './api.js';

/** Home Assistant API calls, all through the generated client. */
export const loadConnection = async (): Promise<Connection> =>
	unwrap(await api.GET('/api/v1/homeassistant/connection'));

/** Connects, or changes the connection; the token goes to the server once and is not kept here. */
export async function connect(input: { url: string; token: string }): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.connect', { body: input }));
}

export async function checkAgain(): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.check', { body: {} }));
}

export async function disconnect(): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.disconnect', { body: {} }));
}
