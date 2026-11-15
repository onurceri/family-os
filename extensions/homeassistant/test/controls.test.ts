import { describe, expect, it } from 'vitest';
import type { Value } from '../src/contract/index.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import { answerKey, askKey, controlsFor } from '../src/web/controls.ts';

const binary = (on: boolean): Value => ({ kind: 'binary', on, deviceClass: null });
const word = (
	domain: 'lock' | 'cover' | 'valve' | 'vacuum' | 'media_player',
	state: string,
): Value => ({
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
		expect(controlsFor('humidifier.dehumidifier', binary(true))).toEqual([
			{ kind: 'switch', on: true, operation: 'turn_off' },
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

	it('presses a button or an input button', () => {
		expect(controlsFor('button.doorbell', { kind: 'lastRun', at: 1 })).toEqual([
			{ kind: 'button', operation: 'press', label: 'op_press' },
		]);
		expect(ops('input_button.bell', { kind: 'lastRun', at: null })).toEqual(['press']);
		expect(ops('button.doorbell', { kind: 'unavailable' })).toEqual(['press']);
	});

	it('offers a valve what a cover gets', () => {
		const v = (state: string) => ops('valve.garden', word('valve', state));
		expect(v('open')).toEqual(['close_valve']);
		expect(v('closed')).toEqual(['open_valve']);
		expect(v('opening')).toEqual(['stop_valve']);
		expect(v('closing')).toEqual(['stop_valve']);
		expect(ops('valve.garden', { kind: 'unavailable' })).toEqual(['open_valve', 'close_valve']);
		expect(v('something_new')).toEqual(['open_valve', 'close_valve']);
	});

	it('offers a vacuum what makes sense for what it is doing', () => {
		const v = (state: string) => ops('vacuum.robot', word('vacuum', state));
		expect(v('cleaning')).toEqual(['pause', 'return_to_base']);
		expect(v('paused')).toEqual(['start', 'return_to_base']);
		expect(v('idle')).toEqual(['start', 'return_to_base']);
		expect(v('error')).toEqual(['start', 'return_to_base']);
		expect(v('returning')).toEqual(['start']);
		expect(v('docked')).toEqual(['start']);
		expect(ops('vacuum.robot', { kind: 'unavailable' })).toEqual(['start', 'return_to_base']);
		expect(controlsFor('vacuum.robot', word('vacuum', 'cleaning'))).toEqual([
			{ kind: 'button', operation: 'pause', label: 'op_pause' },
			{ kind: 'button', operation: 'return_to_base', label: 'op_return_to_base' },
		]);
	});

	it('offers a media player play, pause and power by its state', () => {
		const m = (state: string) => ops('media_player.tv', word('media_player', state));
		expect(m('playing')).toEqual(['media_pause', 'turn_off']);
		expect(m('buffering')).toEqual(['media_pause', 'turn_off']);
		expect(m('paused')).toEqual(['media_play', 'turn_off']);
		expect(m('idle')).toEqual(['media_play', 'turn_off']);
		expect(m('on')).toEqual(['media_play', 'turn_off']);
		expect(m('off')).toEqual(['turn_on']);
		expect(m('standby')).toEqual(['turn_on']);
		expect(ops('media_player.tv', { kind: 'unavailable' })).toEqual(['media_play', 'media_pause']);
		expect(controlsFor('media_player.tv', word('media_player', 'off'))).toEqual([
			{ kind: 'button', operation: 'turn_on', label: 'op_turn_on' },
		]);
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
			['button.a', 'press'],
			['valve.a', 'open_valve'],
			['valve.a', 'close_valve'],
			['valve.a', 'stop_valve'],
			['vacuum.a', 'start'],
			['vacuum.a', 'pause'],
			['vacuum.a', 'return_to_base'],
			['media_player.a', 'media_play'],
			['media_player.a', 'media_pause'],
			['media_player.a', 'turn_on'],
			['media_player.a', 'turn_off'],
		] as const) {
			expect(keys).toContain(askKey(entityId, operation));
			expect(keys).toContain(answerKey(entityId, operation));
		}
	});
});
