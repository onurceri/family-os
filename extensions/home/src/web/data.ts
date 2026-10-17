import { unwrap } from '@famos/api-client';
import type {
	AddHomeInput,
	AddItemInput,
	AddServiceInput,
	Home,
	HomeReplace,
	Item,
	Service,
	ServiceReplace,
	UpdateItemInput,
} from '../contract/index.js';
import { api } from './api.js';

/** Home API calls, all through the generated client. */
export type Outcome = 'applied' | 'drafted';

export const loadHomes = async (): Promise<Home[]> => unwrap(await api.GET('/api/v1/home/homes'));

export const loadHome = async (homeId: string): Promise<Home> =>
	unwrap(await api.GET('/api/v1/home/homes/{homeId}', { params: { path: { homeId } } }));

export const loadItems = async (homeId?: string): Promise<Item[]> =>
	unwrap(await api.GET('/api/v1/home/items', { params: { query: homeId ? { homeId } : {} } }));

export const loadItem = async (itemId: string): Promise<Item> =>
	unwrap(await api.GET('/api/v1/home/items/{itemId}', { params: { path: { itemId } } }));

export const loadServices = async (homeId?: string): Promise<Service[]> =>
	unwrap(await api.GET('/api/v1/home/services', { params: { query: homeId ? { homeId } : {} } }));

export const loadService = async (serviceId: string): Promise<Service> =>
	unwrap(await api.GET('/api/v1/home/services/{serviceId}', { params: { path: { serviceId } } }));

type Result = { outcome: Outcome; id: string | null };
const result = (r: { status: Outcome; output?: unknown }): Result => ({
	outcome: r.status,
	id:
		r.status === 'applied' && r.output && typeof r.output === 'object' && 'id' in r.output
			? String(r.output.id)
			: null,
});

export async function addHome(input: AddHomeInput): Promise<Result> {
	return result(unwrap(await api.POST('/api/v1/actions/home.addHome', { body: input })));
}
export const updateHome = async (id: string, home: HomeReplace): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/home.updateHome', { body: { id, home } })).status;
export const archiveHome = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/home.archiveHome', { body: { id } })).status;

export async function addItem(input: AddItemInput): Promise<Result> {
	return result(unwrap(await api.POST('/api/v1/actions/home.addItem', { body: input })));
}
export const updateItem = async (input: UpdateItemInput): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/home.updateItem', { body: input })).status;
export const archiveItem = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/home.archiveItem', { body: { id } })).status;

export async function addService(input: AddServiceInput): Promise<Result> {
	return result(unwrap(await api.POST('/api/v1/actions/home.addService', { body: input })));
}
export const updateService = async (id: string, service: ServiceReplace): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/home.updateService', { body: { id, service } })).status;
export const archiveService = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/home.archiveService', { body: { id } })).status;
