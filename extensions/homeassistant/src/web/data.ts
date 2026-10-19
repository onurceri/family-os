import { unwrap } from '@famos/api-client';
import type {
	Connection,
	Entities,
	Item,
	MySharing,
	NotifyTargets,
	Operation,
	PersonLink,
	Persons,
	PresenceList,
	SharingLevel,
	SwitchHistory,
	TestResult,
	Values,
} from '../contract/index.js';
import { api } from './api.js';

/** Home Assistant API calls, all through the generated client. */
export const loadConnection = async (): Promise<Connection> =>
	unwrap(await api.GET('/api/v1/homeassistant/connection'));

/** Connects, or changes the connection; the token goes to the server once and is not kept here. */
export async function connect(input: { url: string; token: string }): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.connect', { body: input }));
}

/** Tries an address and a token without saving them. */
export const testConnection = async (input: { url: string; token: string }): Promise<TestResult> =>
	unwrap(await api.POST('/api/v1/homeassistant/connection/test', { body: input }));

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

export const loadPresence = async (): Promise<PresenceList> =>
	unwrap(await api.GET('/api/v1/homeassistant/presence'));

export const loadLinks = async (): Promise<PersonLink[]> =>
	unwrap(await api.GET('/api/v1/homeassistant/people')).links;

export const loadPersons = async (): Promise<Persons> =>
	unwrap(await api.GET('/api/v1/homeassistant/persons'));

export async function linkPerson(input: { memberId: string; personEntity: string }): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.linkPerson', { body: input }));
}

export async function unlinkPerson(memberId: string): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.unlinkPerson', { body: { memberId } }));
}

export const loadMySharing = async (): Promise<MySharing> =>
	unwrap(await api.GET('/api/v1/homeassistant/people/me'));

export async function setMySharing(input: {
	level: SharingLevel;
	onDisplays: boolean;
}): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.setMySharing', { body: input }));
}

export async function setItemControl(input: {
	id: string;
	control: boolean;
	confirm: boolean;
}): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.setItemControl', { body: input }));
}

/** Asks for a switch; Home Assistant is called right after, and the next read shows it. */
export async function switchItem(id: string, operation: Operation): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.switch', { body: { id, operation } }));
}

/** The latest switches, newest first; of one item when `itemId` is given. */
export const loadHistory = async (query: {
	itemId?: string;
	limit?: number;
}): Promise<SwitchHistory> =>
	unwrap(await api.GET('/api/v1/homeassistant/switches', { params: { query } }));

/** Home Assistant's notify services, the member's own phones first. */
export const loadNotifyTargets = async (memberId: string): Promise<NotifyTargets> =>
	unwrap(
		await api.GET('/api/v1/homeassistant/notify-targets', { params: { query: { memberId } } }),
	);

/** Chooses the phone a member's texts go to (or none). */
export async function setNotifyTarget(input: {
	memberId: string;
	service: string | null;
}): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.setNotifyTarget', { body: input }));
}

/** Sends a short text to the member's phone; the row says how it went when the job is done. */
export async function testNotify(memberId: string): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/homeassistant.testNotify', { body: { memberId } }));
}
