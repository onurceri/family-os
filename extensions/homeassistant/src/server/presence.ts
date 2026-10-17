import {
	MAX_PLACE,
	PERSON_ENTITY_PATTERN,
	type Presence,
	type SharingLevel,
} from '../contract/index.ts';

/**
 * Reading where a person is. Home Assistant's answer for a `person.*` holds their coordinates,
 * their accuracy, their zones and their devices; the only way in is `readPerson`, which keeps the
 * state word and when it changed, and drops everything else before anything looks at it.
 */

/** The little kept of a person's answer. */
export interface PersonState {
	entityId: string;
	/** `home`, `not_home`, a zone's name, or `unknown`. */
	state: string;
	/** When the state last changed, in epoch milliseconds. */
	since: number | null;
}

/** The state of one parsed `person.*` answer, or null when it is not one. */
export function readPerson(body: unknown): PersonState | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	const { entity_id, state, last_changed } = body as {
		entity_id?: unknown;
		state?: unknown;
		last_changed?: unknown;
	};
	if (typeof entity_id !== 'string' || !PERSON_ENTITY_PATTERN.test(entity_id)) return null;
	if (typeof state !== 'string') return null;
	const changed = typeof last_changed === 'string' ? Date.parse(last_changed) : Number.NaN;
	return {
		entityId: entity_id,
		state: state.trim().slice(0, 200),
		since: Number.isFinite(changed) ? changed : null,
	};
}

/** What a person's state shows at the level they chose (`none` is never read at all). */
export function toPresence(
	person: PersonState | null,
	level: Exclude<SharingLevel, 'none'>,
): Presence {
	const state = person?.state ?? '';
	if (state === '' || state === 'unknown' || state === 'unavailable') return { kind: 'unknown' };
	if (state === 'home') return { kind: 'home' };
	if (level === 'home' || state === 'not_home') return { kind: 'away' };
	return { kind: 'place', name: state.slice(0, MAX_PLACE) };
}

/** Where the person of a `GET /api/states/person.…` body is, at the level they chose. */
export const presenceOf = (body: unknown, level: Exclude<SharingLevel, 'none'>): Presence =>
	toPresence(readPerson(body), level);

/** A person as the admin's list needs them: the id and the name, nothing else. */
export function pickPerson(body: unknown): { entityId: string; name: string } | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	const { entity_id, attributes } = body as { entity_id?: unknown; attributes?: unknown };
	if (typeof entity_id !== 'string' || !PERSON_ENTITY_PATTERN.test(entity_id)) return null;
	const name =
		typeof attributes === 'object' && attributes !== null
			? (attributes as { friendly_name?: unknown }).friendly_name
			: undefined;
	return {
		entityId: entity_id,
		name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : entity_id,
	};
}
