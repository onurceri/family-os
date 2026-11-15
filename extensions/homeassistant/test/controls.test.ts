import { describe, expect, it } from 'vitest';
import type { Value } from '../src/contract/index.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import { answerKey, askKey, controlsFor, detailFor, levelRequest } from '../src/web/controls.ts';

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

describe('a fan with speeds', () => {
	const fan = (on: boolean, percentage: number | null, step: number | null): Value => ({
		kind: 'binary',
		on,
		deviceClass: null,
		speed: { percentage, step },
	});
	const detail = (v: Value) => detailFor('fan.winix_play_room', v);

	it('keeps the switch on its row, and the speeds for the sheet', () => {
		expect(controlsFor('fan.winix_play_room', fan(true, 25, 25))).toEqual([
			{ kind: 'switch', on: true, operation: 'turn_off' },
		]);
		expect(controlsFor('fan.winix_play_room', fan(false, 0, 25))).toEqual([
			{ kind: 'switch', on: false, operation: 'turn_on' },
		]);
		expect(detail(fan(true, 25, 25))).toEqual({ kind: 'speed', speeds: 4, current: 1 });
	});

	it('says the speed it is on, 0 when off, null when it does not say', () => {
		expect(detail(fan(true, 50, 25))).toEqual({ kind: 'speed', speeds: 4, current: 2 });
		expect(detail(fan(true, 100, 25))).toEqual({ kind: 'speed', speeds: 4, current: 4 });
		expect(detail(fan(false, 0, 25))).toEqual({ kind: 'speed', speeds: 4, current: 0 });
		// Between steps rounds to the nearest; never below 1 while on, never above the last.
		expect(detail(fan(true, 40, 25))).toMatchObject({ current: 2 });
		expect(detail(fan(true, 1, 25))).toMatchObject({ current: 1 });
		expect(detail(fan(true, 120, 25))).toMatchObject({ current: 4 });
		expect(detail(fan(true, null, 25))).toMatchObject({ speeds: 4, current: null });
		expect(detail(fan(true, 33, 33.33))).toMatchObject({ speeds: 3, current: 1 });
	});

	it('has no speeds to pick when they are not known, one, or too many', () => {
		for (const v of [fan(true, 50, null), fan(true, 100, 100), fan(true, 1, 1), fan(false, 0, 1)])
			expect(detail(v)).toBeNull();
		expect(detail(binary(false))).toBeNull();
		expect(detail(fan(true, 100, 100 / 6))).toMatchObject({ speeds: 6 });
		expect(detail(fan(true, 100, 100 / 7))).toBeNull();
		// Only a fan has speeds.
		expect(detailFor('light.kitchen', fan(true, 25, 25))).toBeNull();
	});

	it('asks for the percentage Home Assistant rounds to that speed', () => {
		expect(levelRequest(2, 4)).toEqual({ operation: 'set_percentage', percentage: 50, level: 2 });
		// Home Assistant rounds up to the next speed: 66, not 67, is speed 2 of 3.
		expect(levelRequest(2, 3)).toEqual({ operation: 'set_percentage', percentage: 66, level: 2 });
		expect(levelRequest(3, 3)).toMatchObject({ percentage: 100 });
		for (const speeds of [2, 3, 4, 5, 6])
			for (let level = 1; level <= speeds; level++) {
				const percentage = levelRequest(level, speeds).percentage ?? 0;
				expect(Math.ceil((speeds * percentage) / 100)).toBe(level);
			}
	});

	it('has words for its sheet', () => {
		const keys = new Set(Object.keys(en));
		for (const key of [
			'speed_label',
			'speed_level',
			'speed_set',
			'value_speed',
			'sheet_done',
			'sheet_open',
		])
			expect(keys).toContain(key);
	});
});
