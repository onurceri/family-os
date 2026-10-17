import { ENTITY_ID_PATTERN, STATE_DOMAINS, type Value } from '../contract/index.ts';

/**
 * Reading one entity of Home Assistant. An entity's answer holds much more than FamilyOS needs
 * (coordinates, accuracy, who a device belongs to), so the only way in is `pickState`, which keeps
 * seven fields and nothing else, and refuses persons, device trackers and zones.
 */

/** Home Assistant's own words are kept this short: they are shown, nothing more. */
const MAX_TEXT = 100;

/** The few things kept of an entity. */
export interface PickedState {
	entityId: string;
	state: string;
	unit: string | null;
	deviceClass: string | null;
	name: string | null;
	/** A thermostat's current temperature. */
	temperature: number | null;
	/** When the state last changed, in epoch milliseconds. */
	changedAt: number | null;
}

const text = (value: unknown, max = MAX_TEXT): string | null =>
	typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** The picked fields of one parsed entity object, or null when it is not a readable entity. */
export function pickState(body: unknown): PickedState | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	const raw = body as {
		entity_id?: unknown;
		state?: unknown;
		attributes?: unknown;
		last_changed?: unknown;
	};
	if (typeof raw.entity_id !== 'string' || !ENTITY_ID_PATTERN.test(raw.entity_id)) return null;
	if (typeof raw.state !== 'string') return null;
	const attributes =
		typeof raw.attributes === 'object' && raw.attributes !== null && !Array.isArray(raw.attributes)
			? (raw.attributes as Record<string, unknown>)
			: {};
	const changed = typeof raw.last_changed === 'string' ? Date.parse(raw.last_changed) : Number.NaN;
	const temperature = attributes.current_temperature;
	return {
		entityId: raw.entity_id,
		state: raw.state.slice(0, MAX_TEXT),
		unit: text(attributes.unit_of_measurement, 20),
		deviceClass: text(attributes.device_class, 40),
		name: text(attributes.friendly_name),
		temperature:
			typeof temperature === 'number' && Number.isFinite(temperature) ? temperature : null,
		changedAt: Number.isFinite(changed) ? changed : null,
	};
}

/** `parseState` for the body of `GET /api/states/<entity_id>`; null on anything malformed. */
export function parseState(body: string): PickedState | null {
	try {
		return pickState(JSON.parse(body));
	} catch {
		return null;
	}
}

const LAST_USED_DOMAINS = new Set(['scene', 'button', 'input_button']);
const domainOf = (entityId: string) => entityId.slice(0, entityId.indexOf('.'));

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** What the entity reads, as data. Words and number formats are the interface's job. */
export function toValue(state: PickedState): Value {
	const word = state.state.trim();
	if (word === 'unknown' || word === 'unavailable' || word === '') return { kind: 'unavailable' };
	// A scene or a button has no state of its own: Home Assistant gives when it was last used.
	if (state.deviceClass === 'timestamp' || LAST_USED_DOMAINS.has(domainOf(state.entityId))) {
		const at = Date.parse(word);
		if (Number.isFinite(at)) return { kind: 'time', at };
	}
	if (NUMBER.test(word)) {
		const value = Number(word);
		if (Number.isFinite(value)) return { kind: 'number', value, unit: state.unit };
	}
	const domain = domainOf(state.entityId);
	if ((STATE_DOMAINS as readonly string[]).includes(domain))
		return {
			kind: 'state',
			domain: domain as (typeof STATE_DOMAINS)[number],
			state: word,
			temperature: state.temperature,
		};
	// A binary sensor, a light, a switch, a fan: anything that is on or off.
	if (word === 'on' || word === 'off')
		return { kind: 'binary', on: word === 'on', deviceClass: state.deviceClass };
	return { kind: 'text', text: word };
}
