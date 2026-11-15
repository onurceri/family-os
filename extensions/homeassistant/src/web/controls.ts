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

/** What a tap asks for: the operation, and for a fan's speed the percentage and the level. */
export interface SwitchRequest {
	operation: Operation;
	percentage?: number;
	level?: number;
}

/** The request of a pick in a fan's speeds: the percentage Home Assistant rounds to that level. */
export function levelRequest(level: number, speeds: number): SwitchRequest {
	return { operation: 'set_percentage', percentage: percentageForLevel(level, speeds), level };
}

/**
 * What a row offers beyond its own control, in a sheet that opens from the row: how much, where
 * the row only says on or off. Only a fan's speed so far; `current` is 0 when off and null when
 * it is on and Home Assistant does not say how fast.
 */
export type Detail = { kind: 'speed'; speeds: number; current: number | null };

export function detailFor(entityId: string, value: Value): Detail | null {
	if (controlDomain(entityId) !== 'fan') return null;
	const speeds = fanSpeeds(value);
	return speeds ? { kind: 'speed', ...speeds } : null;
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
export function askKey(entityId: string, operation: Exclude<Operation, 'set_percentage'>) {
	const domain = controlDomain(entityId);
	if ((domain === 'scene' || domain === 'script') && operation === 'turn_on') return 'ask_run';
	return `ask_${operation}` as const;
}

/** The answer button of a confirm sheet: the operation's own word. */
export function answerKey(entityId: string, operation: Exclude<Operation, 'set_percentage'>) {
	const domain = controlDomain(entityId);
	if ((domain === 'scene' || domain === 'script') && operation === 'turn_on') return 'op_run';
	return `op_${operation}` as const;
}

/** How a value reads as data, to tell when a switch has shown up in it. */
export const valueKey = (value: Value) => JSON.stringify(value);

/** How long a row keeps saying "Switching…" at most, and how often it reads meanwhile. */
export const SETTLE_MS = 10_000;
export const POLL_MS = 2_000;
