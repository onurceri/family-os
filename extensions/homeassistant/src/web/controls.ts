import {
	controlDomain,
	fanSpeeds,
	type Operation,
	percentageForLevel,
	type Value,
} from '../contract/index.js';

/**
 * What a row offers for a thing the family allowed switching: one switch for what is on or off,
 * buttons for the rest. Which buttons depends on the state, so a row offers what makes sense now
 * (a locked door offers Unlock) and both when the state is not known.
 */
export type Control =
	| { kind: 'switch'; on: boolean; operation: Operation }
	| { kind: 'button'; operation: Operation; label: ButtonLabel };

/** What a tap asks for: the operation, what it sets, and for a fan's speed the level for the history. */
export interface SwitchRequest {
	operation: Operation;
	value?: number | string;
	level?: number;
}

/** The operations that set something: they carry a value and have a sheet, never a button. */
const VALUE_OPERATIONS = [
	'set_percentage',
	'set_preset_mode',
	'set_humidity',
	'set_mode',
	'set_cover_position',
	'set_valve_position',
	'volume_set',
] as const satisfies readonly Operation[];
export type ValueOperation = (typeof VALUE_OPERATIONS)[number];
export type PlainOperation = Exclude<Operation, ValueOperation>;

/** A request that is a plain operation, as a row's buttons and switch make. */
export function isPlain(
	request: SwitchRequest,
): request is SwitchRequest & { operation: PlainOperation } {
	return (
		request.value === undefined &&
		!(VALUE_OPERATIONS as readonly string[]).includes(request.operation)
	);
}

/** The request of a pick in a fan's speeds: the percentage Home Assistant rounds to that level. */
export function levelRequest(level: number, speeds: number): SwitchRequest {
	return { operation: 'set_percentage', value: percentageForLevel(level, speeds), level };
}

/** The things a number group sets, and the things an option group chooses. */
export type LevelField = 'brightness' | 'position' | 'humidity' | 'volume';
export type OptionField = 'mode' | 'preset';

/**
 * What a row offers beyond its own control, in a sheet that opens from the row: how much, where
 * the row only says on or off. A fan's speed in steps, a number on a slider (a percentage; `min`,
 * `max` and `step` are what the slider offers), or one of a few options. `current` of a speed is
 * 0 when off and null when it is on and Home Assistant does not say how fast.
 */
export type Detail =
	| { kind: 'speed'; speeds: number; current: number | null }
	| {
			kind: 'level';
			field: LevelField;
			operation: Operation;
			percent: number | null;
			min: number;
			max: number;
			step: number;
	  }
	| {
			kind: 'options';
			field: OptionField;
			operation: Operation;
			options: string[];
			current: string | null;
	  };

/** The key a detail is staged under. */
export const detailKey = (detail: Detail): 'speed' | LevelField | OptionField =>
	detail.kind === 'speed' ? 'speed' : detail.field;

const POSITION_OPERATION = { cover: 'set_cover_position', valve: 'set_valve_position' } as const;

/** The sheet's groups for a thing, in the order they show; none when it offers nothing more. */
export function detailsFor(entityId: string, value: Value): Detail[] {
	const domain = controlDomain(entityId);
	const details: Detail[] = [];
	if (domain === 'fan') {
		const speeds = fanSpeeds(value);
		if (speeds) details.push({ kind: 'speed', ...speeds });
	}
	if (value.kind !== 'binary' && value.kind !== 'state') return details;
	const levels = value.levels;
	if (!levels) return details;
	if (domain === 'light' && levels.brightness)
		details.push({
			kind: 'level',
			field: 'brightness',
			operation: 'turn_on',
			percent: levels.brightness.percent,
			min: 1,
			max: 100,
			step: 5,
		});
	if ((domain === 'cover' || domain === 'valve') && levels.position)
		details.push({
			kind: 'level',
			field: 'position',
			operation: POSITION_OPERATION[domain],
			percent: levels.position.percent,
			min: 0,
			max: 100,
			step: 5,
		});
	if (domain === 'humidifier' && levels.humidity)
		details.push({
			kind: 'level',
			field: 'humidity',
			operation: 'set_humidity',
			percent: levels.humidity.target,
			min: levels.humidity.min,
			max: levels.humidity.max,
			step: 1,
		});
	if (domain === 'humidifier' && levels.mode)
		details.push({ kind: 'options', field: 'mode', operation: 'set_mode', ...levels.mode });
	if (domain === 'media_player' && levels.volume)
		details.push({
			kind: 'level',
			field: 'volume',
			operation: 'volume_set',
			percent: levels.volume.percent,
			min: 0,
			max: 100,
			step: 5,
		});
	if (domain === 'fan' && levels.preset)
		details.push({
			kind: 'options',
			field: 'preset',
			operation: 'set_preset_mode',
			...levels.preset,
		});
	return details;
}

/** The request that sets a group to what was picked (a volume is sent as a fraction). */
export function pickRequest(detail: Detail, picked: number | string): SwitchRequest {
	if (detail.kind === 'speed') return levelRequest(Number(picked), detail.speeds);
	if (detail.kind === 'level')
		return {
			operation: detail.operation,
			value: detail.field === 'volume' ? Number(picked) / 100 : Number(picked),
		};
	return { operation: detail.operation, value: picked };
}

/** What was staged in a sheet that asks first, per group (absent: not touched). */
export type Staged = Partial<Record<'speed' | LevelField | OptionField, number | string>>;

/**
 * What "Set" sends in a sheet that asks first: one request per changed group, and a turn-on when
 * power was staged on. `on` is what the thing is now and `power` what was staged (null: not
 * touched). A brightness or a speed picked while it is off needs no turn-on, as it turns the thing
 * on in Home Assistant; turning it off wins over anything picked before.
 */
export function stagedRequests(input: {
	on: boolean;
	power: boolean | null;
	details: Detail[];
	staged: Staged;
}): SwitchRequest[] {
	const { on, power, details, staged } = input;
	if (power === false) return on ? [{ operation: 'turn_off' }] : [];
	const requests: SwitchRequest[] = [];
	let turnsOn = false;
	for (const detail of details) {
		const picked = staged[detailKey(detail)];
		if (picked === undefined) continue;
		const current =
			detail.kind === 'speed'
				? detail.current
				: detail.kind === 'level'
					? detail.percent
					: detail.current;
		const differs = picked !== current;
		const setsOn =
			detail.kind === 'speed' || (detail.kind === 'level' && detail.field === 'brightness');
		if (setsOn ? !on || differs : differs) {
			requests.push(pickRequest(detail, picked));
			if (setsOn) turnsOn = true;
		}
	}
	if (power === true && !on && !turnsOn) requests.unshift({ operation: 'turn_on' });
	return requests;
}

/** The words of a button, a key of the extension's catalog. */
export type ButtonLabel =
	| 'op_open_cover'
	| 'op_close_cover'
	| 'op_stop_cover'
	| 'op_lock'
	| 'op_unlock'
	| 'op_open_valve'
	| 'op_close_valve'
	| 'op_stop_valve'
	| 'op_start'
	| 'op_pause'
	| 'op_return_to_base'
	| 'op_media_play'
	| 'op_media_pause'
	| 'op_turn_on'
	| 'op_turn_off'
	| 'op_press'
	| 'op_run';

const stateOf = (value: Value) => (value.kind === 'state' ? value.state : null);

export function controlsFor(entityId: string, value: Value): Control[] {
	const domain = controlDomain(entityId);
	switch (domain) {
		case null:
			return [];
		case 'light':
		case 'switch':
		case 'fan':
		case 'humidifier':
		case 'input_boolean': {
			const on = value.kind === 'binary' && value.on;
			return [{ kind: 'switch', on, operation: on ? 'turn_off' : 'turn_on' }];
		}
		case 'cover': {
			const state = stateOf(value);
			if (state === 'opening' || state === 'closing')
				return [{ kind: 'button', operation: 'stop_cover', label: 'op_stop_cover' }];
			const open = { kind: 'button', operation: 'open_cover', label: 'op_open_cover' } as const;
			const close = { kind: 'button', operation: 'close_cover', label: 'op_close_cover' } as const;
			if (state === 'open') return [close];
			if (state === 'closed') return [open];
			return [open, close];
		}
		case 'lock': {
			const state = stateOf(value);
			const lock = { kind: 'button', operation: 'lock', label: 'op_lock' } as const;
			const unlock = { kind: 'button', operation: 'unlock', label: 'op_unlock' } as const;
			if (state === 'locked') return [unlock];
			if (state === 'unlocked') return [lock];
			return [lock, unlock];
		}
		case 'valve': {
			const state = stateOf(value);
			if (state === 'opening' || state === 'closing')
				return [{ kind: 'button', operation: 'stop_valve', label: 'op_stop_valve' }];
			const open = { kind: 'button', operation: 'open_valve', label: 'op_open_valve' } as const;
			const close = { kind: 'button', operation: 'close_valve', label: 'op_close_valve' } as const;
			if (state === 'open') return [close];
			if (state === 'closed') return [open];
			return [open, close];
		}
		case 'vacuum': {
			const state = stateOf(value);
			const start = { kind: 'button', operation: 'start', label: 'op_start' } as const;
			const pause = { kind: 'button', operation: 'pause', label: 'op_pause' } as const;
			const home = {
				kind: 'button',
				operation: 'return_to_base',
				label: 'op_return_to_base',
			} as const;
			if (state === 'cleaning') return [pause, home];
			if (state === 'returning' || state === 'docked') return [start];
			return [start, home];
		}
		case 'media_player': {
			const state = stateOf(value);
			const play = { kind: 'button', operation: 'media_play', label: 'op_media_play' } as const;
			const pause = { kind: 'button', operation: 'media_pause', label: 'op_media_pause' } as const;
			const on = { kind: 'button', operation: 'turn_on', label: 'op_turn_on' } as const;
			const off = { kind: 'button', operation: 'turn_off', label: 'op_turn_off' } as const;
			if (state === 'playing' || state === 'buffering') return [pause, off];
			if (state === 'paused' || state === 'idle' || state === 'on') return [play, off];
			if (state === 'off' || state === 'standby') return [on];
			return [play, pause];
		}
		case 'button':
		case 'input_button':
			return [{ kind: 'button', operation: 'press', label: 'op_press' }];
		case 'scene':
		case 'script':
			return [{ kind: 'button', operation: 'turn_on', label: 'op_run' }];
	}
}

/** The question a confirm sheet asks ("Unlock {{name}}?"), a key of the extension's catalog. */
export function askKey(entityId: string, operation: PlainOperation) {
	const domain = controlDomain(entityId);
	if ((domain === 'scene' || domain === 'script') && operation === 'turn_on') return 'ask_run';
	return `ask_${operation}` as const;
}

/** The answer button of a confirm sheet: the operation's own word. */
export function answerKey(entityId: string, operation: PlainOperation) {
	const domain = controlDomain(entityId);
	if ((domain === 'scene' || domain === 'script') && operation === 'turn_on') return 'op_run';
	return `op_${operation}` as const;
}

/** How a value reads as data, to tell when a switch has shown up in it. */
export const valueKey = (value: Value) => JSON.stringify(value);

/** How long a row keeps saying "Switching…" at most, and how often it reads meanwhile. */
export const SETTLE_MS = 10_000;
export const POLL_MS = 2_000;
