import { describe, expect, it } from 'vitest';
import type { Value } from '../src/contract/index.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import {
	answerKey,
	askKey,
	controlsFor,
	detailsFor,
	levelRequest,
	pickRequest,
	stagedRequests,
} from '../src/web/controls.ts';

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
	const detail = (v: Value) =>
		detailsFor('fan.winix_play_room', v).find((d) => d.kind === 'speed') ?? null;

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
		expect(detailsFor('light.kitchen', fan(true, 25, 25))).toEqual([]);
	});

	it('asks for the percentage Home Assistant rounds to that speed', () => {
		expect(levelRequest(2, 4)).toEqual({ operation: 'set_percentage', value: 50, level: 2 });
		// Home Assistant rounds up to the next speed: 66, not 67, is speed 2 of 3.
		expect(levelRequest(2, 3)).toEqual({ operation: 'set_percentage', value: 66, level: 2 });
		expect(levelRequest(3, 3)).toMatchObject({ value: 100 });
		for (const speeds of [2, 3, 4, 5, 6])
			for (let level = 1; level <= speeds; level++) {
				const percentage = Number(levelRequest(level, speeds).value);
				expect(Math.ceil((speeds * percentage) / 100)).toBe(level);
			}
	});

	it('sends what a staged power and speed ask for, never more than needed', () => {
		const details = detailsFor('fan.winix_play_room', {
			kind: 'binary',
			on: true,
			deviceClass: null,
			speed: { percentage: 50, step: 25 },
		});
		const stage = (
			on: boolean,
			current: number | null,
			power: boolean | null,
			level: number | null,
		) =>
			stagedRequests({
				on,
				power,
				details: details.map((d) => (d.kind === 'speed' ? { ...d, current } : d)),
				staged: level === null ? {} : { speed: level },
			});
		// Nothing changed.
		expect(stage(true, 2, null, null)).toEqual([]);
		expect(stage(true, 2, true, 2)).toEqual([]);
		expect(stage(false, 0, false, null)).toEqual([]);
		// Power alone.
		expect(stage(true, 2, false, null)).toEqual([{ operation: 'turn_off' }]);
		expect(stage(false, 0, true, null)).toEqual([{ operation: 'turn_on' }]);
		// A new speed on a fan that is on, or that is off (the percentage turns it on).
		expect(stage(true, 2, null, 3)).toEqual([levelRequest(3, 4)]);
		expect(stage(false, 0, null, 2)).toEqual([levelRequest(2, 4)]);
		expect(stage(false, 0, true, 2)).toEqual([levelRequest(2, 4)]);
		// On with no known speed: any pick is a change.
		expect(stage(true, null, null, 2)).toEqual([levelRequest(2, 4)]);
		// Turned off wins over a speed picked before: only turn it off, or nothing if already off.
		expect(stage(true, 2, false, 3)).toEqual([{ operation: 'turn_off' }]);
		expect(stage(false, 0, false, 3)).toEqual([]);
	});

	it('has words for its sheet', () => {
		const keys = new Set(Object.keys(en));
		for (const key of [
			'speed_label',
			'speed_level',
			'power_label',
			'set',
			'ask_note',
			'value_speed',
			'sheet_done',
		])
			expect(keys).toContain(key);
	});
});

const lights = (percent: number | null, on = true): Value => ({
	kind: 'binary',
	on,
	deviceClass: null,
	levels: { brightness: { percent } },
});
const withLevels = (
	kind: 'binary' | 'state',
	levels: NonNullable<Extract<Value, { levels?: unknown }>['levels']>,
	on = true,
): Value =>
	kind === 'binary'
		? { kind: 'binary', on, deviceClass: null, levels }
		: { kind: 'state', domain: 'cover', state: 'open', temperature: null, levels };

describe('what a sheet offers', () => {
	it('is nothing for a thing that reports nothing to set', () => {
		expect(detailsFor('light.kitchen', binary(true))).toEqual([]);
		expect(detailsFor('switch.kettle', binary(true))).toEqual([]);
		expect(detailsFor('lock.front_door', word('lock', 'locked'))).toEqual([]);
		expect(detailsFor('cover.garage', word('cover', 'open'))).toEqual([]);
		expect(detailsFor('light.kitchen', { kind: 'unavailable' })).toEqual([]);
	});

	it('is a brightness for a dimmable light, which a plain turn on does not carry', () => {
		expect(detailsFor('light.kitchen', lights(60))).toEqual([
			{
				kind: 'level',
				field: 'brightness',
				operation: 'turn_on',
				percent: 60,
				min: 1,
				max: 100,
				step: 5,
			},
		]);
		// Off, the brightness is not known, and the sheet is still there.
		expect(detailsFor('light.kitchen', lights(null, false))).toHaveLength(1);
		expect(controlsFor('light.kitchen', lights(60))).toEqual([
			{ kind: 'switch', on: true, operation: 'turn_off' },
		]);
	});

	it('is a position for a cover and for a valve, each with its own service', () => {
		const position = (domain: 'cover' | 'valve', percent: number) =>
			detailsFor(`${domain}.x`, {
				kind: 'state',
				domain,
				state: 'open',
				temperature: null,
				levels: { position: { percent } },
			});
		expect(position('cover', 40)).toEqual([
			{
				kind: 'level',
				field: 'position',
				operation: 'set_cover_position',
				percent: 40,
				min: 0,
				max: 100,
				step: 5,
			},
		]);
		expect(position('valve', 0)).toMatchObject([{ operation: 'set_valve_position', percent: 0 }]);
	});

	it('is a target humidity inside the humidifier’s limits, and its modes', () => {
		const value = withLevels('binary', {
			humidity: { target: 45, min: 30, max: 80 },
			mode: { options: ['normal', 'sleep', 'auto'], current: 'normal' },
		});
		expect(detailsFor('humidifier.bedroom', value)).toEqual([
			{
				kind: 'level',
				field: 'humidity',
				operation: 'set_humidity',
				percent: 45,
				min: 30,
				max: 80,
				step: 1,
			},
			{
				kind: 'options',
				field: 'mode',
				operation: 'set_mode',
				options: ['normal', 'sleep', 'auto'],
				current: 'normal',
			},
		]);
		expect(controlsFor('humidifier.bedroom', value)).toEqual([
			{ kind: 'switch', on: true, operation: 'turn_off' },
		]);
	});

	it('is a volume for a media player, whose Play and Pause stay on the row', () => {
		const tv: Value = {
			kind: 'state',
			domain: 'media_player',
			state: 'playing',
			temperature: null,
			levels: { volume: { percent: 30 } },
		};
		expect(detailsFor('media_player.tv', tv)).toEqual([
			{
				kind: 'level',
				field: 'volume',
				operation: 'volume_set',
				percent: 30,
				min: 0,
				max: 100,
				step: 5,
			},
		]);
		expect(ops('media_player.tv', tv)).toEqual(['media_pause', 'turn_off']);
	});

	it('is the speeds and the presets of a fan, in that order', () => {
		const fan: Value = {
			kind: 'binary',
			on: true,
			deviceClass: null,
			speed: { percentage: 25, step: 25 },
			levels: { preset: { options: ['auto', 'sleep'], current: null } },
		};
		expect(detailsFor('fan.winix', fan).map((d) => d.kind)).toEqual(['speed', 'options']);
		// Presets alone, for a fan with no speeds to pick.
		expect(
			detailsFor('fan.winix', { ...fan, speed: { percentage: null, step: null } }).map(
				(d) => d.kind,
			),
		).toEqual(['options']);
	});

	it('offers a group only to the domain that owns it', () => {
		expect(detailsFor('switch.heater', lights(60))).toEqual([]);
		expect(detailsFor('fan.x', lights(60))).toEqual([]);
		expect(
			detailsFor('light.x', withLevels('binary', { preset: { options: ['a'], current: null } })),
		).toEqual([]);
	});

	it('asks for what was picked, a volume as a fraction', () => {
		const [brightness] = detailsFor('light.kitchen', lights(60));
		expect(pickRequest(brightness as never, 35)).toEqual({ operation: 'turn_on', value: 35 });
		const tv: Value = {
			kind: 'state',
			domain: 'media_player',
			state: 'on',
			temperature: null,
			levels: { volume: { percent: 30 } },
		};
		const [volume] = detailsFor('media_player.tv', tv);
		expect(pickRequest(volume as never, 25)).toEqual({ operation: 'volume_set', value: 0.25 });
		expect(pickRequest(volume as never, 100)).toEqual({ operation: 'volume_set', value: 1 });
		const [mode] = detailsFor(
			'humidifier.bedroom',
			withLevels('binary', { mode: { options: ['sleep'], current: null } }),
		);
		expect(pickRequest(mode as never, 'sleep')).toEqual({ operation: 'set_mode', value: 'sleep' });
	});
});

describe('what a sheet that asks first sends', () => {
	const humidifier = (on: boolean) =>
		detailsFor(
			'humidifier.bedroom',
			withLevels(
				'binary',
				{
					humidity: { target: 45, min: 30, max: 80 },
					mode: { options: ['normal', 'sleep'], current: 'normal' },
				},
				on,
			),
		);

	it('is one request per changed group, and none for one left as it is', () => {
		const details = humidifier(true);
		expect(stagedRequests({ on: true, power: null, details, staged: {} })).toEqual([]);
		expect(
			stagedRequests({ on: true, power: null, details, staged: { humidity: 45, mode: 'normal' } }),
		).toEqual([]);
		expect(
			stagedRequests({ on: true, power: null, details, staged: { humidity: 55, mode: 'sleep' } }),
		).toEqual([
			{ operation: 'set_humidity', value: 55 },
			{ operation: 'set_mode', value: 'sleep' },
		]);
		expect(stagedRequests({ on: true, power: null, details, staged: { mode: 'sleep' } })).toEqual([
			{ operation: 'set_mode', value: 'sleep' },
		]);
	});

	it('turns a humidifier on first when power was staged on, and picking a target does not', () => {
		const details = humidifier(false);
		expect(stagedRequests({ on: false, power: true, details, staged: { humidity: 50 } })).toEqual([
			{ operation: 'turn_on' },
			{ operation: 'set_humidity', value: 50 },
		]);
		expect(stagedRequests({ on: false, power: null, details, staged: { humidity: 50 } })).toEqual([
			{ operation: 'set_humidity', value: 50 },
		]);
	});

	it('turns off and nothing else when power was staged off', () => {
		const details = humidifier(true);
		expect(
			stagedRequests({ on: true, power: false, details, staged: { humidity: 60, mode: 'sleep' } }),
		).toEqual([{ operation: 'turn_off' }]);
		expect(
			stagedRequests({
				on: false,
				power: false,
				details: humidifier(false),
				staged: { mode: 'sleep' },
			}),
		).toEqual([]);
	});

	it('turns a light on with the brightness alone, never with a turn on as well', () => {
		const off = detailsFor('light.kitchen', lights(null, false));
		expect(
			stagedRequests({ on: false, power: null, details: off, staged: { brightness: 40 } }),
		).toEqual([{ operation: 'turn_on', value: 40 }]);
		expect(
			stagedRequests({ on: false, power: true, details: off, staged: { brightness: 40 } }),
		).toEqual([{ operation: 'turn_on', value: 40 }]);
		expect(stagedRequests({ on: false, power: true, details: off, staged: {} })).toEqual([
			{ operation: 'turn_on' },
		]);
		const on = detailsFor('light.kitchen', lights(60));
		expect(
			stagedRequests({ on: true, power: null, details: on, staged: { brightness: 60 } }),
		).toEqual([]);
		expect(
			stagedRequests({ on: true, power: null, details: on, staged: { brightness: 25 } }),
		).toEqual([{ operation: 'turn_on', value: 25 }]);
		expect(
			stagedRequests({ on: true, power: false, details: on, staged: { brightness: 25 } }),
		).toEqual([{ operation: 'turn_off' }]);
	});

	it('moves a cover or sends a volume as it was staged, and nothing when unchanged', () => {
		const cover = detailsFor('cover.window', {
			kind: 'state',
			domain: 'cover',
			state: 'open',
			temperature: null,
			levels: { position: { percent: 40 } },
		});
		expect(
			stagedRequests({ on: false, power: null, details: cover, staged: { position: 70 } }),
		).toEqual([{ operation: 'set_cover_position', value: 70 }]);
		expect(
			stagedRequests({ on: false, power: null, details: cover, staged: { position: 40 } }),
		).toEqual([]);
		const tv = detailsFor('media_player.tv', {
			kind: 'state',
			domain: 'media_player',
			state: 'playing',
			temperature: null,
			levels: { volume: { percent: 30 } },
		});
		expect(stagedRequests({ on: false, power: null, details: tv, staged: { volume: 55 } })).toEqual(
			[{ operation: 'volume_set', value: 0.55 }],
		);
	});
});

describe('the words of the levels', () => {
	it('has words for every group, the readout and the buttons', () => {
		const keys = new Set(Object.keys(en));
		for (const key of [
			'brightness_label',
			'position_label',
			'humidity_label',
			'volume_label',
			'mode_label',
			'preset_label',
			'decrease',
			'increase',
			'value_percent',
			'history_set_value',
			'history_set_volume',
		])
			expect(keys).toContain(key);
	});
});
