import { describe, expect, it } from 'vitest';
import type { Value } from '../src/contract/index.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import { answerKey, askKey, controlsFor } from '../src/web/controls.ts';

const binary = (on: boolean): Value => ({ kind: 'binary', on, deviceClass: null });
const word = (domain: 'lock' | 'cover', state: string): Value => ({
	kind: 'state',
	domain,
	state,
	temperature: null,
});
const ops = (entityId: string, value: Value) =>
	controlsFor(entityId, value).map((c) => c.operation);

describe('the controls of a row', () => {
	it('is one switch for what is on or off', () => {
		expect(controlsFor('light.kitchen', binary(true))).toEqual([
			{ kind: 'switch', on: true, operation: 'turn_off' },
		]);
		expect(controlsFor('fan.bedroom', binary(false))).toEqual([
			{ kind: 'switch', on: false, operation: 'turn_on' },
		]);
		// Not known: shown off, and turning it on is what the switch offers.
		expect(controlsFor('switch.kettle', { kind: 'unavailable' })).toEqual([
			{ kind: 'switch', on: false, operation: 'turn_on' },
		]);
	});

	it('offers what makes sense now for covers and locks, and both when not known', () => {
		expect(ops('cover.garage', word('cover', 'open'))).toEqual(['close_cover']);
		expect(ops('cover.garage', word('cover', 'closed'))).toEqual(['open_cover']);
		expect(ops('cover.garage', word('cover', 'opening'))).toEqual(['stop_cover']);
		expect(ops('cover.garage', { kind: 'unavailable' })).toEqual(['open_cover', 'close_cover']);
		expect(ops('lock.front_door', word('lock', 'locked'))).toEqual(['unlock']);
		expect(ops('lock.front_door', word('lock', 'unlocked'))).toEqual(['lock']);
		expect(ops('lock.front_door', word('lock', 'jammed'))).toEqual(['lock', 'unlock']);
	});

	it('runs scenes and scripts, and offers nothing for what cannot be switched', () => {
		expect(controlsFor('scene.evening', { kind: 'text', text: 'x' })).toEqual([
			{ kind: 'button', operation: 'turn_on', label: 'op_run' },
		]);
		expect(ops('script.bedtime', binary(false))).toEqual(['turn_on']);
		expect(ops('sensor.outside', { kind: 'number', value: 1, unit: null })).toEqual([]);
		expect(ops('climate.living', { kind: 'unavailable' })).toEqual([]);
	});

	it('asks and answers with words the catalog has', () => {
		expect(askKey('lock.front_door', 'unlock')).toBe('ask_unlock');
		expect(askKey('scene.evening', 'turn_on')).toBe('ask_run');
		expect(answerKey('scene.evening', 'turn_on')).toBe('op_run');
		expect(answerKey('light.kitchen', 'turn_on')).toBe('op_turn_on');
		const keys = new Set(Object.keys(en));
		for (const [entityId, operation] of [
			['light.a', 'turn_on'],
			['light.a', 'turn_off'],
			['cover.a', 'open_cover'],
			['cover.a', 'close_cover'],
			['cover.a', 'stop_cover'],
			['lock.a', 'lock'],
			['lock.a', 'unlock'],
			['script.a', 'turn_on'],
		] as const) {
			expect(keys).toContain(askKey(entityId, operation));
			expect(keys).toContain(answerKey(entityId, operation));
		}
	});
});
