import { describe, expect, it } from 'vitest';
import { orderedGroups } from './role-groups.js';

const names: Record<string, string> = {
	core: 'FamilyOS',
	board: 'Board',
	calendar: 'Calendar',
	homeassistant: 'Home Assistant',
	kitchen: 'Kitchen',
	inbox: 'Quick add',
	ambient: 'Photos and weather',
	pets: 'Çiçek',
	vehicles: 'Vehicles',
};
const owners = (locale: string, list: string[]) =>
	orderedGroups(
		list.map((o) => [o, []] as const),
		(o) => names[o] ?? o,
		locale,
	).map(([o]) => o);

describe('orderedGroups', () => {
	it('puts the family-wide group first and the others alphabetically', () => {
		expect(owners('en', ['vehicles', 'inbox', 'core', 'board', 'ambient', 'kitchen'])).toEqual([
			'core',
			'board',
			'kitchen',
			'ambient',
			'inbox',
			'vehicles',
		]);
	});

	it('does not depend on the order it was given', () => {
		const a = owners('en', ['calendar', 'homeassistant', 'board', 'core']);
		const b = owners('en', ['core', 'board', 'homeassistant', 'calendar']);
		expect(a).toEqual(b);
	});

	it('sorts by the reader’s language', () => {
		// In Turkish, "Ç" sorts after "C" and before "D"; in a plain code-point sort it would come last.
		const list = ['pets', 'calendar', 'vehicles'];
		expect(owners('tr', list)).toEqual(['calendar', 'pets', 'vehicles']);
	});
});
