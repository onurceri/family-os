import {
	ENTITY_ID_PATTERN,
	type Levels,
	MAX_OPTION_LENGTH,
	MAX_OPTIONS,
	STATE_DOMAINS,
	type Value,
} from '../contract/index.ts';

/**
 * Reading one entity of Home Assistant. An entity's answer holds much more than FamilyOS needs
 * (coordinates, accuracy, who a device belongs to), so the only way in is `pickState`, which keeps
 * the few fields below and nothing else, and refuses persons, device trackers and zones.
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
	/** A fan's speed in percent. */
	percentage: number | null;
	/** A fan's step: 100 divided by its speed count. */
	percentageStep: number | null;
	/** What it can be set to beyond on and off, when it offers any. */
	levels: Levels | null;
	/** When the state last changed, in epoch milliseconds. */
	changedAt: number | null;
}

const finite = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null;

const text = (value: unknown, max = MAX_TEXT): string | null =>
	typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

const percent = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

/** A list attribute of words (modes, presets), or null when it holds none. */
function words(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const list = value
		.filter((word): word is string => typeof word === 'string' && word.trim() !== '')
		.map((word) => word.trim())
		.filter((word) => word.length <= MAX_OPTION_LENGTH)
		.slice(0, MAX_OPTIONS);
	return list.length > 0 ? list : null;
}

const options = (list: unknown, current: unknown) => {
	const found = words(list);
	return found ? { options: found, current: text(current, MAX_OPTION_LENGTH) } : undefined;
};

/**
 * What a thing offers to set, read from its attributes: a light that dims, a cover's or valve's
 * position, a humidifier's target and modes, a media player's volume, a fan's presets. A light
 * is dimmable when it reports a brightness or any colour mode but plain on and off.
 */
function levelsOf(domain: string, attributes: Record<string, unknown>): Levels | null {
	const levels: Levels = {};
	if (domain === 'light') {
		const brightness = finite(attributes.brightness);
		const modes = attributes.supported_color_modes;
		const dims =
			brightness !== null ||
			(Array.isArray(modes) && modes.some((mode) => typeof mode === 'string' && mode !== 'onoff'));
		if (dims)
			levels.brightness = {
				// 1 of 255 is the dimmest a light can be and still be on.
				percent:
					brightness === null
						? null
						: Math.max(brightness > 0 ? 1 : 0, percent((brightness * 100) / 255)),
			};
	} else if (domain === 'cover' || domain === 'valve') {
		const position = finite(attributes.current_position);
		if (position !== null) levels.position = { percent: percent(position) };
	} else if (domain === 'humidifier') {
		const target = finite(attributes.humidity);
		const min = finite(attributes.min_humidity);
		const max = finite(attributes.max_humidity);
		if (target !== null && min !== null && max !== null && min < max)
			levels.humidity = { target: Math.round(target), min: Math.ceil(min), max: Math.floor(max) };
		const mode = options(attributes.available_modes, attributes.mode);
		if (mode) levels.mode = mode;
	} else if (domain === 'media_player') {
		const volume = finite(attributes.volume_level);
		if (volume !== null) levels.volume = { percent: percent(volume * 100) };
	} else if (domain === 'fan') {
		const preset = options(attributes.preset_modes, attributes.preset_mode);
		if (preset) levels.preset = preset;
	}
	return Object.keys(levels).length > 0 ? levels : null;
}

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
		temperature: finite(temperature),
		percentage: finite(attributes.percentage),
		percentageStep: finite(attributes.percentage_step),
		levels: levelsOf(raw.entity_id.slice(0, raw.entity_id.indexOf('.')), attributes),
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
	// A scene or a button has no state of its own: Home Assistant gives when it was last used,
	// and `unknown` until the first time.
	if (LAST_USED_DOMAINS.has(domainOf(state.entityId))) {
		if (word === 'unknown' || word === '') return { kind: 'lastRun', at: null };
		if (word === 'unavailable') return { kind: 'unavailable' };
		const at = Date.parse(word);
		return Number.isFinite(at) ? { kind: 'lastRun', at } : { kind: 'unavailable' };
	}
	if (word === 'unknown' || word === 'unavailable' || word === '') return { kind: 'unavailable' };
	if (state.deviceClass === 'timestamp') {
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
			...(state.levels ? { levels: state.levels } : {}),
		};
	// A binary sensor, a light, a switch, a fan: anything that is on or off.
	if (word === 'on' || word === 'off') {
		const on = word === 'on';
		const levels = state.levels ? { levels: state.levels } : {};
		if (domain === 'fan')
			return {
				kind: 'binary',
				on,
				deviceClass: state.deviceClass,
				speed: { percentage: state.percentage, step: state.percentageStep },
				...levels,
			};
		return { kind: 'binary', on, deviceClass: state.deviceClass, ...levels };
	}
	return { kind: 'text', text: word };
}
