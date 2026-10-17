import { describe, expect, it } from 'vitest';
import { pickPerson, presenceOf, readPerson } from '../src/server/presence.ts';

/** Person answers as a real Home Assistant (2026.10) gives them. */
const person = (state: string, attributes: Record<string, unknown>) => ({
	entity_id: 'person.alex',
	state,
	attributes,
	last_changed: '2026-10-17T07:45:12.123456+00:00',
	last_reported: '2026-10-17T07:45:12.123456+00:00',
	last_updated: '2026-10-17T07:45:12.123456+00:00',
	context: { id: '01K7', parent_id: null, user_id: null },
});
const HOME = person('home', {
	editable: true,
	id: 'alex',
	device_trackers: ['device_tracker.alex_phone'],
	latitude: 52.3731,
	longitude: 4.8922,
	gps_accuracy: 12,
	source: 'device_tracker.alex_phone',
	in_zones: ['zone.home'],
	user_id: 'a1b2c3',
	friendly_name: 'Alex',
});
const AWAY = person('not_home', {
	editable: true,
	id: 'alex',
	device_trackers: ['device_tracker.alex_phone'],
	latitude: 52.3601,
	longitude: 4.8866,
	gps_accuracy: 30,
	source: 'device_tracker.alex_phone',
	in_zones: [],
	friendly_name: 'Alex',
});
const SCHOOL = person('School', {
	editable: true,
	id: 'alex',
	device_trackers: ['device_tracker.alex_phone'],
	latitude: 52.3555,
	longitude: 4.9001,
	gps_accuracy: 8,
	source: 'device_tracker.alex_phone',
	in_zones: ['zone.school'],
	friendly_name: 'Alex',
});
const UNKNOWN = person('unknown', {
	editable: true,
	id: 'owner',
	device_trackers: [],
	user_id: 'd4e5f6',
	friendly_name: 'Owner',
});

const HIDDEN = [
	'latitude',
	'longitude',
	'gps_accuracy',
	'in_zones',
	'device_trackers',
	'52.3',
	'4.8',
];
const leaks = (value: unknown) => HIDDEN.filter((word) => JSON.stringify(value).includes(word));

describe('presenceOf', () => {
	it('says home, away or the zone, as much as the level shows', () => {
		expect(presenceOf(HOME, 'home')).toEqual({ kind: 'home' });
		expect(presenceOf(HOME, 'place')).toEqual({ kind: 'home' });
		expect(presenceOf(AWAY, 'home')).toEqual({ kind: 'away' });
		expect(presenceOf(AWAY, 'place')).toEqual({ kind: 'away' });
		expect(presenceOf(SCHOOL, 'home')).toEqual({ kind: 'away' });
		expect(presenceOf(SCHOOL, 'place')).toEqual({ kind: 'place', name: 'School' });
	});

	it('knows nothing of a person without trackers, or of an answer that is not a person', () => {
		expect(presenceOf(UNKNOWN, 'place')).toEqual({ kind: 'unknown' });
		expect(presenceOf({ ...HOME, state: 'unavailable' }, 'place')).toEqual({ kind: 'unknown' });
		expect(presenceOf({ ...HOME, state: undefined }, 'place')).toEqual({ kind: 'unknown' });
		expect(presenceOf({ ...HOME, entity_id: 'device_tracker.alex' }, 'place')).toEqual({
			kind: 'unknown',
		});
		expect(presenceOf(null, 'place')).toEqual({ kind: 'unknown' });
		expect(presenceOf([HOME], 'place')).toEqual({ kind: 'unknown' });
	});

	it('never lets a coordinate, a zone list or a device through', () => {
		for (const body of [HOME, AWAY, SCHOOL, UNKNOWN])
			for (const level of ['home', 'place'] as const) {
				expect(leaks(presenceOf(body, level))).toEqual([]);
				expect(leaks(readPerson(body))).toEqual([]);
			}
		expect(readPerson(SCHOOL)).toEqual({
			entityId: 'person.alex',
			state: 'School',
			since: Date.parse('2026-10-17T07:45:12.123456+00:00'),
		});
	});

	it('cuts a long zone name', () => {
		const name = 'A'.repeat(80);
		expect(presenceOf(person(name, {}), 'place')).toEqual({ kind: 'place', name: 'A'.repeat(60) });
	});
});

describe('pickPerson', () => {
	it('keeps the id and the name only', () => {
		expect(pickPerson(HOME)).toEqual({ entityId: 'person.alex', name: 'Alex' });
		expect(leaks(pickPerson(SCHOOL))).toEqual([]);
		expect(pickPerson({ ...UNKNOWN, attributes: {} })).toEqual({
			entityId: 'person.alex',
			name: 'person.alex',
		});
		expect(pickPerson({ entity_id: 'sensor.x', state: '1' })).toBeNull();
	});
});
