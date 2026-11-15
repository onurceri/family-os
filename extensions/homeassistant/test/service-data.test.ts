import { describe, expect, it } from 'vitest';
import {
	bodyUnderRule,
	needsAttributes,
	SERVICE_DATA,
	type ServiceDataRule,
	serviceBody,
	serviceDataRule,
} from '../src/contract/index.ts';

/**
 * The rule shapes the table can hold. Only the fan's speed is in the table; the other kinds are
 * checked here against the same function, so adding an entry later is a one-line change that is
 * already covered.
 */
const check = (rule: ServiceDataRule, value: unknown, attributes?: Record<string, unknown>) =>
	bodyUnderRule(rule, 'test.thing', value, attributes);

describe('the table of service data', () => {
	it('holds exactly one entry: a fan speed, a whole number from 0 to 100', () => {
		expect(SERVICE_DATA).toEqual({
			'fan.set_percentage': {
				kind: 'number',
				field: 'percentage',
				integer: true,
				min: 0,
				max: 100,
			},
		});
		expect(serviceDataRule('fan.winix', 'set_percentage')).toBe(SERVICE_DATA['fan.set_percentage']);
		for (const [entity, operation] of [
			['light.kitchen', 'set_percentage'],
			['fan.winix', 'turn_on'],
			['fan.winix', '__proto__'],
			['fan.winix', 'constructor'],
		] as const)
			expect(serviceDataRule(entity, operation)).toBeNull();
	});

	it('sends the entity alone where nothing is allowed, and refuses any value there', () => {
		expect(serviceBody('light.kitchen', 'turn_on', undefined)).toEqual({
			entity_id: 'light.kitchen',
		});
		expect(serviceBody('light.kitchen', 'turn_on', null)).toEqual({ entity_id: 'light.kitchen' });
		expect(serviceBody('light.kitchen', 'turn_on', 50)).toBeNull();
		expect(serviceBody('fan.winix', 'turn_off', 50)).toBeNull();
		expect(serviceBody('light.kitchen', 'set_percentage', 50)).toBeNull();
	});

	it('takes a fan speed that is a whole number from 0 to 100, and nothing else', () => {
		const body = (v: unknown) => serviceBody('fan.winix', 'set_percentage', v);
		expect(body(25)).toEqual({ entity_id: 'fan.winix', percentage: 25 });
		expect(body(0)).toEqual({ entity_id: 'fan.winix', percentage: 0 });
		expect(body(100)).toEqual({ entity_id: 'fan.winix', percentage: 100 });
		for (const bad of [undefined, null, -1, 101, 12.5, '50', Number.NaN, Number.POSITIVE_INFINITY])
			expect(body(bad)).toBeNull();
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
