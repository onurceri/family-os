import { describe, expect, it } from 'vitest';
import {
	bodyUnderRule,
	CONTROLS,
	needsAttributes,
	SERVICE_DATA,
	type ServiceDataRule,
	serviceBody,
	serviceDataRule,
} from '../src/contract/index.ts';

/**
 * The rule shapes the table can hold. Each entry of the table has its own tests below; the rule
 * kinds are also checked here against the same function.
 */
const check = (rule: ServiceDataRule, value: unknown, attributes?: Record<string, unknown>) =>
	bodyUnderRule(rule, 'test.thing', value, attributes);

const body = (entity: string, operation: string, value: unknown, attributes?: object) =>
	serviceBody(entity, operation, value, attributes as Record<string, unknown> | undefined);

describe('the table of service data', () => {
	it('holds exactly these entries, so adding one is a change this test shows', () => {
		expect(Object.keys(SERVICE_DATA).sort()).toEqual([
			'cover.set_cover_position',
			'fan.set_percentage',
			'fan.set_preset_mode',
			'humidifier.set_humidity',
			'humidifier.set_mode',
			'light.turn_on',
			'media_player.volume_set',
			'valve.set_valve_position',
		]);
		expect(SERVICE_DATA).toEqual({
			'fan.set_percentage': {
				kind: 'number',
				field: 'percentage',
				integer: true,
				min: 0,
				max: 100,
			},
			'fan.set_preset_mode': {
				kind: 'option',
				field: 'preset_mode',
				options: { attribute: 'preset_modes' },
			},
			'light.turn_on': {
				kind: 'number',
				field: 'brightness_pct',
				integer: true,
				min: 1,
				max: 100,
				optional: true,
			},
			'cover.set_cover_position': {
				kind: 'number',
				field: 'position',
				integer: true,
				min: 0,
				max: 100,
			},
			'valve.set_valve_position': {
				kind: 'number',
				field: 'position',
				integer: true,
				min: 0,
				max: 100,
			},
			'humidifier.set_humidity': {
				kind: 'number',
				field: 'humidity',
				integer: true,
				min: { attribute: 'min_humidity' },
				max: { attribute: 'max_humidity' },
			},
			'humidifier.set_mode': {
				kind: 'option',
				field: 'mode',
				options: { attribute: 'available_modes' },
			},
			'media_player.volume_set': {
				kind: 'number',
				field: 'volume_level',
				integer: false,
				min: 0,
				max: 1,
			},
		});
	});

	it('only offers an entry for an operation CONTROLS lists, and only one field each', () => {
		for (const key of Object.keys(SERVICE_DATA)) {
			const [domain, operation] = key.split('.');
			expect(CONTROLS[domain as keyof typeof CONTROLS], key).toContain(operation);
		}
		expect(serviceDataRule('fan.winix', 'set_percentage')).toBe(SERVICE_DATA['fan.set_percentage']);
		for (const [entity, operation] of [
			['light.kitchen', 'set_percentage'],
			['light.kitchen', 'turn_off'],
			['fan.winix', 'turn_on'],
			['fan.winix', '__proto__'],
			['fan.winix', 'constructor'],
			['switch.kettle', 'turn_on'],
			['humidifier.a', 'turn_on'],
			['cover.a', 'open_cover'],
			['media_player.a', 'media_play'],
		] as const)
			expect(serviceDataRule(entity, operation)).toBeNull();
	});

	it('sends the entity alone where nothing is allowed, and refuses any value there', () => {
		expect(body('switch.kettle', 'turn_on', undefined)).toEqual({ entity_id: 'switch.kettle' });
		expect(body('switch.kettle', 'turn_on', null)).toEqual({ entity_id: 'switch.kettle' });
		expect(body('switch.kettle', 'turn_on', 50)).toBeNull();
		expect(body('light.kitchen', 'turn_off', 50)).toBeNull();
		expect(body('fan.winix', 'turn_off', 50)).toBeNull();
		expect(body('fan.winix', 'turn_on', 'sleep')).toBeNull();
		expect(body('light.kitchen', 'set_percentage', 50)).toBeNull();
		expect(body('cover.a', 'open_cover', 40)).toBeNull();
		expect(body('humidifier.a', 'turn_on', 'sleep')).toBeNull();
		expect(body('media_player.a', 'turn_on', 0.5)).toBeNull();
	});

	it('takes a fan speed that is a whole number from 0 to 100, and nothing else', () => {
		const speed = (v: unknown) => body('fan.winix', 'set_percentage', v);
		expect(speed(25)).toEqual({ entity_id: 'fan.winix', percentage: 25 });
		expect(speed(0)).toEqual({ entity_id: 'fan.winix', percentage: 0 });
		expect(speed(100)).toEqual({ entity_id: 'fan.winix', percentage: 100 });
		for (const bad of [undefined, null, -1, 101, 12.5, '50', Number.NaN, Number.POSITIVE_INFINITY])
			expect(speed(bad)).toBeNull();
	});

	it('dims a light with a whole brightness from 1 to 100, and a plain turn on is the entity alone', () => {
		const dim = (v: unknown) => body('light.kitchen', 'turn_on', v);
		expect(dim(undefined)).toEqual({ entity_id: 'light.kitchen' });
		expect(dim(null)).toEqual({ entity_id: 'light.kitchen' });
		expect(Object.keys(dim(undefined) ?? {})).toEqual(['entity_id']);
		expect(dim(60)).toEqual({ entity_id: 'light.kitchen', brightness_pct: 60 });
		expect(dim(1)).toEqual({ entity_id: 'light.kitchen', brightness_pct: 1 });
		expect(dim(100)).toEqual({ entity_id: 'light.kitchen', brightness_pct: 100 });
		for (const bad of [0, 101, -1, 50.5, '60', Number.NaN, Number.POSITIVE_INFINITY, true, {}])
			expect(dim(bad)).toBeNull();
		// Needs nothing from the light itself.
		expect(needsAttributes(SERVICE_DATA['light.turn_on'] as ServiceDataRule)).toBe(false);
	});

	it.each([
		['cover.window', 'set_cover_position'],
		['valve.garden', 'set_valve_position'],
	])('moves %s to a whole position from 0 to 100, and nothing else', (entity, operation) => {
		const move = (v: unknown) => body(entity, operation, v);
		expect(move(40)).toEqual({ entity_id: entity, position: 40 });
		expect(move(0)).toEqual({ entity_id: entity, position: 0 });
		expect(move(100)).toEqual({ entity_id: entity, position: 100 });
		for (const bad of [undefined, null, -1, 101, 40.5, '40', Number.NaN, Number.NEGATIVE_INFINITY])
			expect(move(bad)).toBeNull();
		expect(needsAttributes(serviceDataRule(entity, operation) as ServiceDataRule)).toBe(false);
	});

	it('sets a target humidity inside the limits the humidifier reports, whole', () => {
		const target = (v: unknown, attributes?: object) =>
			body('humidifier.bedroom', 'set_humidity', v, attributes);
		const limits = { min_humidity: 30, max_humidity: 80 };
		expect(target(55, limits)).toEqual({ entity_id: 'humidifier.bedroom', humidity: 55 });
		expect(target(30, limits)).toEqual({ entity_id: 'humidifier.bedroom', humidity: 30 });
		expect(target(80, limits)).toEqual({ entity_id: 'humidifier.bedroom', humidity: 80 });
		for (const bad of [29, 81, 55.5, '55', null, undefined, Number.NaN])
			expect(target(bad, limits)).toBeNull();
		// Missing or malformed limits refuse; before the limits are read only the shape is checked.
		expect(target(55, {})).toBeNull();
		expect(target(55, { min_humidity: 30 })).toBeNull();
		expect(target(55, { min_humidity: '30', max_humidity: 80 })).toBeNull();
		expect(target(55)).toEqual({ entity_id: 'humidifier.bedroom', humidity: 55 });
		expect(target(55.5)).toBeNull();
		expect(needsAttributes(SERVICE_DATA['humidifier.set_humidity'] as ServiceDataRule)).toBe(true);
	});

	it.each([
		['humidifier.bedroom', 'set_mode', 'mode', 'available_modes'],
		['fan.winix', 'set_preset_mode', 'preset_mode', 'preset_modes'],
	])('sets %s %s only to one of the options it lists', (entity, operation, field, list) => {
		const pick = (v: unknown, attributes?: object) => body(entity, operation, v, attributes);
		const listed = { [list]: ['normal', 'sleep'] };
		expect(pick('sleep', listed)).toEqual({ entity_id: entity, [field]: 'sleep' });
		for (const bad of ['turbo', '', 'Sleep', 1, null, undefined])
			expect(pick(bad, listed)).toBeNull();
		// No list, an empty one, one that is not a list, or the wrong attribute: nothing is sent.
		expect(pick('sleep', {})).toBeNull();
		expect(pick('sleep', { [list]: [] })).toBeNull();
		expect(pick('sleep', { [list]: 'sleep' })).toBeNull();
		expect(pick('sleep', { other_modes: ['sleep'] })).toBeNull();
		expect(needsAttributes(serviceDataRule(entity, operation) as ServiceDataRule)).toBe(true);
	});

	it('sets a volume between 0 and 1, not necessarily whole', () => {
		const volume = (v: unknown) => body('media_player.tv', 'volume_set', v);
		expect(volume(0.3)).toEqual({ entity_id: 'media_player.tv', volume_level: 0.3 });
		expect(volume(0)).toEqual({ entity_id: 'media_player.tv', volume_level: 0 });
		expect(volume(1)).toEqual({ entity_id: 'media_player.tv', volume_level: 1 });
		for (const bad of [-0.01, 1.01, 30, '0.3', null, undefined, Number.NaN])
			expect(volume(bad)).toBeNull();
		expect(needsAttributes(SERVICE_DATA['media_player.volume_set'] as ServiceDataRule)).toBe(false);
	});

	it('lets no field through for any other operation of these things', () => {
		for (const [entity, operation] of [
			['light.kitchen', 'turn_off'],
			['cover.window', 'open_cover'],
			['cover.window', 'close_cover'],
			['cover.window', 'stop_cover'],
			['valve.garden', 'open_valve'],
			['humidifier.bedroom', 'turn_on'],
			['media_player.tv', 'media_pause'],
			['fan.winix', 'turn_on'],
		] as const) {
			expect(body(entity, operation, 50), `${entity} ${operation}`).toBeNull();
			expect(body(entity, operation, undefined)).toEqual({ entity_id: entity });
		}
	});
});

describe('a number rule', () => {
	const fixed: ServiceDataRule = { kind: 'number', field: 'level', integer: false, min: 0, max: 1 };
	const limited: ServiceDataRule = {
		kind: 'number',
		field: 'temperature',
		integer: false,
		min: { attribute: 'min_temp' },
		max: { attribute: 'max_temp' },
		step: { attribute: 'target_temp_step' },
	};

	it('holds a value to fixed bounds', () => {
		expect(needsAttributes(fixed)).toBe(false);
		expect(check(fixed, 0.5)).toEqual({ entity_id: 'test.thing', level: 0.5 });
		expect(check(fixed, 1.01)).toBeNull();
		expect(check(fixed, -0.1)).toBeNull();
		expect(check(fixed, 'x')).toBeNull();
		expect(check(fixed, undefined)).toBeNull();
	});

	it('holds a value to the limits and the step the entity reports', () => {
		expect(needsAttributes(limited)).toBe(true);
		const attributes = { min_temp: 7, max_temp: 35, target_temp_step: 0.5 };
		expect(check(limited, 21.5, attributes)).toEqual({
			entity_id: 'test.thing',
			temperature: 21.5,
		});
		expect(check(limited, 7, attributes)).toEqual({ entity_id: 'test.thing', temperature: 7 });
		expect(check(limited, 35, attributes)).toEqual({ entity_id: 'test.thing', temperature: 35 });
		expect(check(limited, 36, attributes)).toBeNull();
		expect(check(limited, 6.5, attributes)).toBeNull();
		expect(check(limited, 21.3, attributes)).toBeNull();
	});

	it('refuses when an attribute it depends on is missing or not a number', () => {
		expect(check(limited, 21, {})).toBeNull();
		expect(check(limited, 21, { min_temp: 7, max_temp: 35 })).toBeNull();
		expect(check(limited, 21, { min_temp: '7', max_temp: 35, target_temp_step: 1 })).toBeNull();
		expect(check(limited, 21, { min_temp: 7, max_temp: 35, target_temp_step: 0 })).toBeNull();
	});

	it('leaves the attribute checks to the job when they have not been read', () => {
		expect(check(limited, 21)).toEqual({ entity_id: 'test.thing', temperature: 21 });
	});

	it('can require whole numbers with attribute bounds', () => {
		const whole: ServiceDataRule = {
			kind: 'number',
			field: 'position',
			integer: true,
			min: 0,
			max: { attribute: 'top' },
		};
		expect(check(whole, 40, { top: 50 })).toEqual({ entity_id: 'test.thing', position: 40 });
		expect(check(whole, 40.5, { top: 50 })).toBeNull();
		expect(check(whole, 60, { top: 50 })).toBeNull();
	});
});

describe('an option rule', () => {
	const modes: ServiceDataRule = {
		kind: 'option',
		field: 'preset_mode',
		options: { attribute: 'preset_modes' },
	};

	it('takes a value the entity lists, and no other', () => {
		expect(needsAttributes(modes)).toBe(true);
		const attributes = { preset_modes: ['auto', 'sleep'] };
		expect(check(modes, 'sleep', attributes)).toEqual({
			entity_id: 'test.thing',
			preset_mode: 'sleep',
		});
		expect(check(modes, 'turbo', attributes)).toBeNull();
		expect(check(modes, '', attributes)).toBeNull();
		expect(check(modes, 1, attributes)).toBeNull();
	});

	it('refuses when the entity lists no options', () => {
		expect(check(modes, 'sleep', {})).toBeNull();
		expect(check(modes, 'sleep', { preset_modes: 'sleep' })).toBeNull();
		expect(check(modes, 'sleep', { preset_modes: [] })).toBeNull();
	});

	it('leaves the list to the job when it has not been read', () => {
		expect(check(modes, 'sleep')).toEqual({ entity_id: 'test.thing', preset_mode: 'sleep' });
	});
});
