import { unwrap } from '@famos/api-client';
import type { Connection, Entities, Item, Values } from '../contract/index.js';
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

export const loadValues = async (): Promise<Values> =>
	unwrap(await api.GET('/api/v1/homeassistant/values'));

export const loadItems = async (): Promise<Item[]> =>
	unwrap(await api.GET('/api/v1/homeassistant/items')).items;

export const findEntities = async (q: string): Promise<Entities> =>
	unwrap(await api.GET('/api/v1/homeassistant/entities', { params: { query: { q } } }));

export async function addItem(input: { entityId: string; label: string }): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.addItem', { body: input }));
}

export async function renameItem(input: { id: string; label: string }): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.renameItem', { body: input }));
}

export async function removeItem(id: string): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.removeItem', { body: { id } }));
}

export async function moveItem(id: string, position: number): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.moveItem', { body: { id, position } }));
}
