import { describe, expect, it } from 'vitest';
import { parseState, toValue } from '../src/server/state.ts';

const body = (extra: Record<string, unknown>) =>
	JSON.stringify({
		last_reported: '2026-10-17T09:00:00+00:00',
		last_updated: '2026-10-17T09:00:00+00:00',
		context: { id: '01J', parent_id: null, user_id: null },
		...extra,
	});

const SENSOR = body({
	entity_id: 'sensor.outside_temperature',
	state: '15.6',
	attributes: {
		state_class: 'measurement',
		unit_of_measurement: '°C',
		device_class: 'temperature',
		friendly_name: 'Outside Temperature',
	},
	last_changed: '2026-10-17T08:30:00+00:00',
});

describe('parseState', () => {
	it('keeps the entity, the state, the unit, the class, the name, the temperature and when it changed', () => {
		expect(parseState(SENSOR)).toEqual({
			entityId: 'sensor.outside_temperature',
			state: '15.6',
			unit: '°C',
			deviceClass: 'temperature',
			name: 'Outside Temperature',
			temperature: null,
			changedAt: Date.parse('2026-10-17T08:30:00+00:00'),
		});
	});

	it('cuts long texts', () => {
		const long = 'x'.repeat(300);
		const picked = parseState(
			body({
				entity_id: 'sensor.long',
				state: long,
				attributes: { friendly_name: long },
				last_changed: '2026-10-17T08:30:00+00:00',
			}),
		);
		expect(picked?.state).toHaveLength(100);
		expect(picked?.name).toHaveLength(100);
	});

	it('refuses a person, a tracker and a zone', () => {
		const person = body({
			entity_id: 'person.alex',
			state: 'not_home',
			attributes: { latitude: 52.3601, longitude: 4.8866, gps_accuracy: 12, friendly_name: 'Alex' },
			last_changed: '2026-10-17T08:30:00+00:00',
		});
		expect(parseState(person)).toBeNull();
		for (const id of ['device_tracker.alex_phone', 'zone.home', 'person.sam'])
			expect(parseState(body({ entity_id: id, state: 'on', attributes: {} }))).toBeNull();
	});

	it('never lets coordinates through, even from a sensor that carries them', () => {
		const picked = parseState(
			body({
				entity_id: 'sensor.phone_location',
				state: 'School',
				attributes: {
					latitude: 52.3601,
					longitude: 4.8866,
					gps_accuracy: 5,
					friendly_name: 'Phone',
				},
				last_changed: '2026-10-17T08:30:00+00:00',
			}),
		);
		expect(picked).not.toBeNull();
		const shown = JSON.stringify([picked, toValue(picked as NonNullable<typeof picked>)]);
		expect(shown).not.toContain('52.36');
		expect(shown).not.toContain('4.88');
		expect(shown).not.toContain('latitude');
	});

	it.each([
		'',
		'not json',
		'[]',
		'null',
		'{"entity_id":"sensor.a"}',
		'{"entity_id":"sensor.a","state":5}',
		'{"entity_id":"sensor.A","state":"1"}',
	])('is null on %j', (text) => {
		expect(parseState(text)).toBeNull();
	});
});

const value = (entityId: string, state: string, attributes: Record<string, unknown> = {}) => {
	const picked = parseState(body({ entity_id: entityId, state, attributes }));
	if (!picked) throw new Error('refused');
	return toValue(picked);
};

describe('toValue', () => {
	it('reads a number with the unit as Home Assistant gives it', () => {
		const picked = parseState(SENSOR);
		expect(picked && toValue(picked)).toEqual({ kind: 'number', value: 15.6, unit: '°C' });
		expect(value('sensor.n', '-3')).toEqual({ kind: 'number', value: -3, unit: null });
		expect(value('sensor.n', '1e3', { unit_of_measurement: 'W' })).toEqual({
			kind: 'number',
			value: 1000,
			unit: 'W',
		});
	});

	it('reads an unknown or unavailable state as not available', () => {
		expect(value('sensor.a', 'unknown')).toEqual({ kind: 'unavailable' });
		expect(value('sensor.a', 'unavailable')).toEqual({ kind: 'unavailable' });
	});

	it('reads a timestamp sensor as a time', () => {
		expect(
			value('sensor.done', '2026-10-17T10:15:00+00:00', { device_class: 'timestamp' }),
		).toEqual({ kind: 'time', at: Date.parse('2026-10-17T10:15:00+00:00') });
	});

	it('reads a scene or a button as when it was last used', () => {
		// What the lab Home Assistant answered for a scene that had just run.
		expect(value('scene.evening', '2026-10-17T19:13:34.384776+00:00')).toEqual({
			kind: 'time',
			at: Date.parse('2026-10-17T19:13:34.384776+00:00'),
		});
		expect(value('input_button.bell', '2026-10-17T10:15:00+00:00')).toMatchObject({
			kind: 'time',
		});
		expect(value('scene.evening', 'unknown')).toEqual({ kind: 'unavailable' });
	});

	it('reads an enum sensor as Home Assistant’s own word', () => {
		expect(value('sensor.mode', 'eco', { device_class: 'enum', options: ['eco'] })).toEqual({
			kind: 'text',
			text: 'eco',
		});
	});

	it('reads a binary sensor as on or off with its class', () => {
		expect(value('binary_sensor.door', 'on', { device_class: 'door' })).toEqual({
			kind: 'binary',
			on: true,
			deviceClass: 'door',
		});
		expect(value('binary_sensor.door', 'off')).toEqual({
			kind: 'binary',
			on: false,
			deviceClass: null,
		});
	});

	it('reads a light, a switch and a fan as on or off', () => {
		expect(value('light.kitchen', 'on')).toEqual({ kind: 'binary', on: true, deviceClass: null });
		expect(value('switch.heater', 'off')).toEqual({ kind: 'binary', on: false, deviceClass: null });
	});

	it('reads a lock and a cover by their state words', () => {
		expect(value('lock.front_door', 'jammed')).toEqual({
			kind: 'state',
			domain: 'lock',
			state: 'jammed',
			temperature: null,
		});
		expect(value('cover.garage', 'opening')).toMatchObject({ kind: 'state', domain: 'cover' });
	});

	it('reads a thermostat by its state and current temperature, and nothing else of it', () => {
		const read = value('climate.hall', 'heat', {
			current_temperature: 21.5,
			temperature: 23,
			hvac_modes: ['heat', 'off'],
			friendly_name: 'Hall',
		});
		expect(read).toEqual({ kind: 'state', domain: 'climate', state: 'heat', temperature: 21.5 });
	});

	it('says any other state as Home Assistant says it', () => {
		expect(value('weather.home', 'sunny')).toEqual({ kind: 'text', text: 'sunny' });
		expect(value('media_player.tv', 'playing')).toEqual({ kind: 'text', text: 'playing' });
	});

	it('does not make a number of an odd text', () => {
		expect(value('sensor.x', '12abc')).toEqual({ kind: 'text', text: '12abc' });
		expect(value('sensor.x', 'Infinity')).toEqual({ kind: 'text', text: 'Infinity' });
	});
});
