import {
	defineRoute,
	type ExtensionContext,
	type ExternalHttpRequest,
	isExternalHttpError,
} from '@famos/sdk';
import {
	type Entities,
	EntitiesQuerySchema,
	EntitiesSchema,
	type Persons,
	PersonsSchema,
	type PresenceList,
	type Value,
	type Values,
	ValuesSchema,
} from '../contract/index.ts';
import { homeassistantManage, homeassistantView } from './capabilities.ts';
import { load } from './connection.ts';
import { loadItems, mayControl } from './items.ts';
import { ENTITY_MAX_BYTES, ENTITY_TIMEOUT_MS, LIST_MAX_BYTES, LIST_TIMEOUT_MS } from './limits.ts';
import { pickPerson } from './presence.ts';
import { type PickedState, pickState, toValue } from './state.ts';

/**
 * Home Assistant's values, read live and kept for a minute, so many Today pages and displays
 * cause one round of requests a minute. Only the six picked fields of an entity are kept (see
 * `pickState`). Nothing is stored: a stale value is never shown as current. Just after a switch
 * they are kept only briefly, so the person who switched sees the new state as it arrives.
 */

export const CACHE_MS = 60_000;
/** How long values are kept while a switch settles (a lock unlocking, a cover moving). */
export const SETTLING_CACHE_MS = 1_500;
/** How long after a switch values are kept only briefly. */
export const SETTLING_MS = 15_000;
export const AT_ONCE = 4;
const MAX_ENTITIES = 50;

interface Cached<T> {
	key: string;
	at: number;
	value: T;
}

/** What one running server remembers, per extension context; it is never persisted. */
interface Memory {
	values: Cached<Values> | null;
	entities: Cached<{
		status: Entities['status'];
		all: Listed[];
		persons: Persons['persons'];
	}> | null;
	/** The `notify` services Home Assistant offered, by the connection they were read for. */
	services: Cached<{ status: 'ok' | 'unavailable'; names: string[] }> | null;
	/** By who asks (a display sees fewer people), each with its own key. */
	presence: Map<string, Cached<PresenceList>>;
	/** Rounds in flight, so concurrent callers share one. */
	inflight: Map<string, Promise<unknown>>;
	/** Until when values are kept only briefly, after a switch. */
	settlingUntil: number;
	/** Moves on every switch, so a read begun before one is never kept. */
	switches: number;
}

interface Listed {
	entityId: string;
	name: string;
	value: Value;
}

const memories = new WeakMap<object, Memory>();

/**
 * The memory of the extension's context. A job's context is a copy of the routes' one that shares
 * its ports, so the memory belongs to the extension's own database view: a switch job then drops
 * what the values route keeps.
 */
export function memoryOf(ctx: ExtensionContext): Memory {
	let memory = memories.get(ctx.db);
	if (!memory) {
		memory = {
			values: null,
			entities: null,
			services: null,
			presence: new Map(),
			inflight: new Map(),
			settlingUntil: 0,
			switches: 0,
		};
		memories.set(ctx.db, memory);
	}
	return memory;
}

/** After a switch: the next read is live, and reads stay nearly live while the change settles. */
export function forgetValues(ctx: ExtensionContext): void {
	const memory = memoryOf(ctx);
	memory.values = null;
	memory.settlingUntil = ctx.clock.now() + SETTLING_MS;
	memory.switches++;
}

export function once<T>(memory: Memory, key: string, work: () => Promise<T>): Promise<T> {
	const running = memory.inflight.get(key);
	if (running) return running as Promise<T>;
	const promise = work().finally(() => memory.inflight.delete(key));
	memory.inflight.set(key, promise);
	return promise;
}

/** The address and the opened token, or null when not connected (or the token cannot be opened). */
export async function credentials(ctx: ExtensionContext) {
	const row = await load(ctx.db);
	if (!row) return null;
	const token = ctx.secrets.open(row.sealed_token);
	return { baseUrl: row.base_url, token, stamp: row.updated_at };
}

export const request = (
	baseUrl: string,
	token: string,
	path: string,
	timeoutMs: number,
	maxBytes: number,
): ExternalHttpRequest => ({
	url: `${baseUrl}${path}`,
	allowLocal: true,
	headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
	timeoutMs,
	maxBytes,
});

const UNAVAILABLE: Value = { kind: 'unavailable' };

/** Runs `work` for each of `list`, at most `limit` at a time; stops starting new ones after a throw. */
export async function inParallel<T>(
	list: readonly T[],
	limit: number,
	work: (entry: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	let failure: { error: unknown } | null = null;
	const worker = async () => {
		while (!failure && next < list.length) {
			const entry = list[next++] as T;
			try {
				await work(entry);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
	if (failure) throw (failure as { error: unknown }).error;
}

async function readValues(ctx: ExtensionContext): Promise<Values> {
	const connection = await credentials(ctx);
	if (!connection || connection.token === null) return { items: [], status: 'not_connected' };
	const rows = await loadItems(ctx.db);
	if (rows.length === 0) return { items: [], status: 'ok' };
	const { baseUrl, token } = connection;
	const found = new Map<string, PickedState | null>();
	try {
		await inParallel(rows, AT_ONCE, async (row) => {
			try {
				const response = await ctx.http.get(
					request(
						baseUrl,
						token,
						`/api/states/${row.entity_id}`,
						ENTITY_TIMEOUT_MS,
						ENTITY_MAX_BYTES,
					),
				);
				const picked = response.status === 200 ? safePick(response.text) : null;
				// Asked for this entity and got another one: nothing to trust.
				found.set(row.id, picked?.entityId === row.entity_id ? picked : null);
			} catch (error) {
				// Home Assistant answers 404 for an entity it does not have (any more): that item only.
				if (isExternalHttpError(error) && error.code === 'http_404') found.set(row.id, null);
				else throw error;
			}
		});
	} catch (error) {
		// A refused token, an unreachable or broken Home Assistant: nothing is current, show nothing.
		ctx.logger.info(
			{ code: isExternalHttpError(error) ? error.code : 'failed' },
			'home assistant values unavailable',
		);
		return { items: [], status: 'unavailable' };
	}
	return {
		status: 'ok',
		items: rows.map((row) => {
			const picked = found.get(row.id) ?? null;
			return {
				id: row.id,
				entityId: row.entity_id as Values['items'][number]['entityId'],
				label: row.label,
				name: picked?.name ?? null,
				value: picked ? toValue(picked) : UNAVAILABLE,
				changedAt: picked?.changedAt ?? null,
				control: mayControl(row),
				confirm: row.confirm === 1,
			};
		}),
	};
}

function safePick(body: string): PickedState | null {
	try {
		return pickState(JSON.parse(body));
	} catch {
		return null;
	}
}

export const getValues = defineRoute({
	method: 'get',
	path: '/values',
	operationId: 'homeassistant.getValues',
	summary: 'What the family shows from Home Assistant, read live (cached for a minute)',
	requires: homeassistantView.id,
	response: ValuesSchema,
	async handle(ctx) {
		const memory = memoryOf(ctx);
		const connection = await credentials(ctx);
		if (!connection) return { items: [], status: 'not_connected' as const };
		const rows = await loadItems(ctx.db);
		const key = JSON.stringify([
			connection.stamp,
			rows.map((r) => [r.id, r.entity_id, r.updated_at]),
		]);
		const now = ctx.clock.now();
		const hit = memory.values;
		const keep = now < memory.settlingUntil ? SETTLING_CACHE_MS : CACHE_MS;
		if (hit && hit.key === key && now - hit.at >= 0 && now - hit.at < keep) return hit.value;
		// A round that began before a switch is not joined, nor kept: it may hold the old state.
		const generation = memory.switches;
		const value = await once(memory, `values:${generation}:${key}`, () => readValues(ctx));
		if (memory.switches === generation) memory.values = { key, at: ctx.clock.now(), value };
		return value;
	},
});

type Listing = { status: Entities['status']; all: Listed[]; persons: Persons['persons'] };

/**
 * Every entity Home Assistant has that may be shown, reduced to name and value, and its people,
 * reduced to id and name: one read of the whole list serves both pickers.
 */
async function readEntities(ctx: ExtensionContext): Promise<Listing> {
	const none = (status: Entities['status']): Listing => ({ status, all: [], persons: [] });
	const connection = await credentials(ctx);
	if (!connection || connection.token === null) return none('not_connected');
	try {
		const response = await ctx.http.get(
			request(connection.baseUrl, connection.token, '/api/states', LIST_TIMEOUT_MS, LIST_MAX_BYTES),
		);
		if (response.status !== 200) return none('unavailable');
		const body: unknown = JSON.parse(response.text);
		if (!Array.isArray(body)) return none('unavailable');
		const all: Listed[] = [];
		const persons: Persons['persons'] = [];
		for (const entry of body) {
			const person = pickPerson(entry);
			if (person) {
				persons.push(person as Persons['persons'][number]);
				continue;
			}
			const picked = pickState(entry);
			if (picked)
				all.push({
					entityId: picked.entityId,
					name: picked.name ?? picked.entityId,
					value: toValue(picked),
				});
		}
		const byName = (a: { name: string; entityId: string }, b: { name: string; entityId: string }) =>
			a.name.localeCompare(b.name) || a.entityId.localeCompare(b.entityId);
		all.sort(byName);
		persons.sort(byName);
		return { status: 'ok', all, persons };
	} catch (error) {
		if (isExternalHttpError(error) && error.code === 'too_large') return none('too_many');
		ctx.logger.info(
			{ code: isExternalHttpError(error) ? error.code : 'failed' },
			'home assistant entities unavailable',
		);
		return none('unavailable');
	}
}

/** The whole list, read at most once a minute for both pickers. */
async function listing(ctx: ExtensionContext, stamp: number): Promise<Listing> {
	const memory = memoryOf(ctx);
	const key = String(stamp);
	const now = ctx.clock.now();
	const hit = memory.entities;
	if (hit && hit.key === key && now - hit.at >= 0 && now - hit.at < CACHE_MS) return hit.value;
	const value = await once(memory, `entities:${key}`, () => readEntities(ctx));
	memory.entities = { key, at: ctx.clock.now(), value };
	return value;
}

export const getEntities = defineRoute({
	method: 'get',
	path: '/entities',
	operationId: 'homeassistant.findEntities',
	summary:
		'The entities Home Assistant has that can be shown (not people or places), by name or id (at most 50)',
	requires: homeassistantManage.id,
	query: EntitiesQuerySchema,
	response: EntitiesSchema,
	async handle(ctx, { query }) {
		const connection = await credentials(ctx);
		if (!connection) return { entities: [], status: 'not_connected' as const, more: false };
		const { status, all } = await listing(ctx, connection.stamp);
		const needle = query.q?.toLowerCase();
		const matched = needle
			? all.filter((e) => e.entityId.includes(needle) || e.name.toLowerCase().includes(needle))
			: all;
		const entities = matched
			.slice(0, MAX_ENTITIES)
			.map((e) => ({ ...e, entityId: e.entityId as Entities['entities'][number]['entityId'] }));
		return { entities, status, more: matched.length > MAX_ENTITIES };
	},
});

export const getPersons = defineRoute({
	method: 'get',
	path: '/persons',
	operationId: 'homeassistant.listPersons',
	summary: 'The people Home Assistant has, by id and name only, to link them to members',
	requires: homeassistantManage.id,
	response: PersonsSchema,
	async handle(ctx) {
		const connection = await credentials(ctx);
		if (!connection) return { persons: [], status: 'not_connected' as const };
		const { status, persons } = await listing(ctx, connection.stamp);
		return { persons, status };
	},
});
