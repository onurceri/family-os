import type { NavContribution } from '@famos/ui/slots';
import { describe, expect, it } from 'vitest';
import { byName, groupedByName, orderedBy } from './nav-order.js';

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

describe('pages inside a group', () => {
	const entries = [
		page('pets', 20, 'pets:nav'),
		page('vehicles', 10, 'vehicles:nav'),
		page('home', 20, 'home:nav'),
		page('chores', 5, 'chores:nav'),
	];

	it('are alphabetical by name whatever number each asked for', () => {
		const [group] = groupedByName(entries, byName(label, 'en'));
		expect(group?.items.map((i) => i.id)).toEqual(['chores', 'home', 'pets', 'vehicles']);
	});

	it("follow the reader's language", () => {
		const items = [page('a', 1, 'a:nav'), page('b', 2, 'b:nav'), page('home', 3, 'home:nav')];
		const ids = (locale: string) =>
			groupedByName(items, byName(label, locale))[0]?.items.map((i) => i.id);
		expect(ids('de')).toEqual(['b', 'home', 'a']);
	});

	it('keep the groups in the order they come in', () => {
		const items = [
			{ ...page('pets', 1, 'pets:nav'), group: 'zoo' },
			{ ...page('home', 2, 'home:nav'), group: 'house' },
			{ ...page('chores', 3, 'chores:nav'), group: 'zoo' },
		];
		const groups = groupedByName(items, byName(label, 'en'));
		expect(groups.map((g) => [g.group, g.items.map((i) => i.id)])).toEqual([
			['zoo', ['chores', 'pets']],
			['house', ['home']],
		]);
	});
});
