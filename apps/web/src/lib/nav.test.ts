import type { NavContribution } from '@famos/ui/slots';
import { describe, expect, it } from 'vitest';
import { orderedBy } from './nav-order.js';

// Only the fields the order and the grouping read.
const page = (id: string, order: number | undefined, labelKey: string) =>
	({
		id,
		order,
		labelKey,
		path: `/${id}`,
		placement: 'more',
		group: 'household',
	}) as unknown as NavContribution;

const labels: Record<string, string> = {
	'home:nav': 'Home',
	'pets:nav': 'Pets',
	'vehicles:nav': 'Vehicles',
	'chores:nav': 'Chores',
	'a:nav': 'Zebra',
	'b:nav': 'Ärger',
};
const label = (key: string) => labels[key] ?? key;

describe('page order', () => {
	const entries = [
		page('pets', 20, 'pets:nav'),
		page('vehicles', 10, 'vehicles:nav'),
		page('home', 20, 'home:nav'),
		page('chores', 5, 'chores:nav'),
	];

	it('breaks a tie by the name the reader sees, whichever page loaded first', () => {
		const order = (list: NavContribution[]) =>
			list.toSorted(orderedBy(label, 'en')).map((i) => i.id);
		expect(order(entries)).toEqual(['chores', 'vehicles', 'home', 'pets']);
		expect(order([...entries].reverse())).toEqual(['chores', 'vehicles', 'home', 'pets']);
	});

	it("compares names in the reader's language", () => {
		const sort = (locale: string) =>
			[page('a', 1, 'a:nav'), page('b', 1, 'b:nav')]
				.toSorted(orderedBy(label, locale))
				.map((p) => p.id);
		expect(sort('de')).toEqual(['b', 'a']);
	});

	it('falls back to the id for two pages with one name', () => {
		const same = [page('y', 1, 'same'), page('x', 1, 'same')];
		expect(same.toSorted(orderedBy(label, 'en')).map((p) => p.id)).toEqual(['x', 'y']);
	});
});
