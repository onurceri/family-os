import { controlDomain, type Operation, type Value } from '../contract/index.js';

/**
 * What a row offers for a thing the family allowed switching: one switch for what is on or off,
 * buttons for the rest. Which buttons depends on the state, so a row offers what makes sense now
 * (a locked door offers Unlock) and both when the state is not known.
 */
export type Control =
	| { kind: 'switch'; on: boolean; operation: Operation }
	| { kind: 'button'; operation: Operation; label: ButtonLabel };

/** The words of a button, a key of the extension's catalog. */
export type ButtonLabel =
	| 'op_open_cover'
	| 'op_close_cover'
	| 'op_stop_cover'
	| 'op_lock'
	| 'op_unlock'
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
		case 'scene':
		case 'script':
			return [{ kind: 'button', operation: 'turn_on', label: 'op_run' }];
	}
}

/** The question a confirm sheet asks ("Unlock {{name}}?"), a key of the extension's catalog. */
export function askKey(entityId: string, operation: Operation) {
	const domain = controlDomain(entityId);
	if ((domain === 'scene' || domain === 'script') && operation === 'turn_on') return 'ask_run';
	return `ask_${operation}` as const;
}

/** The answer button of a confirm sheet: the operation's own word. */
export function answerKey(entityId: string, operation: Operation) {
	const domain = controlDomain(entityId);
	if ((domain === 'scene' || domain === 'script') && operation === 'turn_on') return 'op_run';
	return `op_${operation}` as const;
}

/** How a value reads as data, to tell when a switch has shown up in it. */
export const valueKey = (value: Value) => JSON.stringify(value);

/** How long a row keeps saying "Switching…" at most, and how often it reads meanwhile. */
export const SETTLE_MS = 10_000;
export const POLL_MS = 2_000;
