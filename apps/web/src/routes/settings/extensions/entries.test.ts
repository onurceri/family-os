import { describe, expect, it } from 'vitest';
import {
	descriptionOf,
	type Entry,
	nameOf,
	neededBy,
	reachOf,
	restartNeeded,
	sections,
	staysInside,
} from './entries.js';

function entry(id: string, more: Partial<Entry> = {}): Entry {
	return {
		id,
		version: '0.1.0',
		status: 'loaded',
		reason: null,
		always: false,
		enabled: true,
		dependsOn: [],
		optional: [],
		reaches: { hosts: [], userUrls: false, local: false, calls: [], capabilities: [] },
		labels: { en: { name: id.toUpperCase(), description: `About ${id}` } },
		...more,
	};
}

describe('names', () => {
	const pets = entry('pets', {
		labels: {
			en: { name: 'Pets', description: 'Vaccinations and vet visits' },
			tr: { name: 'Evcil hayvanlar', description: 'Asilar ve veteriner' },
		},
	});

	it('prefers the running extension’s own catalog, then the package in the page’s language', () => {
		expect(nameOf(pets, { language: 'tr', loaded: { name: 'Hayvanlar' } })).toBe('Hayvanlar');
		expect(nameOf(pets, { language: 'tr' })).toBe('Evcil hayvanlar');
		expect(descriptionOf(pets, { language: 'tr' })).toBe('Asilar ve veteriner');
	});

	it('falls back to English, then to the id', () => {
		expect(nameOf(pets, { language: 'de' })).toBe('Pets');
		expect(nameOf(entry('x', { labels: {} }), { language: 'en' })).toBe('x');
		expect(descriptionOf(entry('x', { labels: {} }), { language: 'en' })).toBe('');
	});
});

describe('sections', () => {
	it('puts everything the family chose under Installed and the rest under Available, by name', () => {
		const list = [
			entry('vehicles', { status: 'available' }),
			entry('pets', { status: 'pending_install' }),
			entry('calendar', { always: true }),
			entry('ambient', { status: 'failed', reason: 'boom' }),
			entry('home', { status: 'available' }),
			entry('kitchen', { status: 'pending_uninstall' }),
		];
		const { installed, available } = sections(list, (e) => e.id);
		expect(installed.map((e) => e.id)).toEqual(['ambient', 'calendar', 'kitchen', 'pets']);
		expect(available.map((e) => e.id)).toEqual(['home', 'vehicles']);
	});
});

describe('what an extension reaches', () => {
	it('names its hosts, typed addresses, the home network and the permissions it adds', () => {
		const calendar = entry('calendar', {
			reaches: {
				hosts: [],
				userUrls: true,
				local: true,
				calls: [],
				capabilities: ['calendar.view', 'calendar.edit'],
			},
		});
		const reach = reachOf(calendar, [calendar]);
		expect(reach).toMatchObject({ hosts: [], userUrls: true, local: true, capabilities: 2 });
		expect(staysInside(reach)).toBe(false);
		expect(staysInside(reachOf(entry('board'), []))).toBe(true);
	});

	it('says what installs alongside: what it needs that is not installed yet, the whole chain', () => {
		const records = entry('records', { status: 'available' });
		const papers = entry('papers', { status: 'available', dependsOn: ['records'] });
		const pets = entry('pets', { status: 'available', dependsOn: ['papers', 'records'] });
		const reach = reachOf(pets, [records, papers, pets]);
		expect(reach.needs).toEqual(['papers', 'records']);
		expect(reach.alongside).toEqual(['papers', 'records']);
		// Something installed already does not come along again.
		expect(reachOf(pets, [{ ...records, status: 'loaded' }, papers, pets]).alongside).toEqual([
			'papers',
		]);
	});

	it('works with the extensions it may use without needing them, never core or itself', () => {
		const kitchen = entry('kitchen', {
			status: 'available',
			dependsOn: ['records'],
			optional: ['lists'],
			reaches: {
				hosts: [],
				userUrls: false,
				local: false,
				calls: ['lists.addShoppingItems', 'calendar.listEvents', 'core.recallMemories'],
				capabilities: [],
			},
		});
		expect(reachOf(kitchen, [kitchen]).worksWith).toEqual(['lists', 'calendar']);
		const own = entry('pets', {
			dependsOn: ['records'],
			reaches: {
				hosts: [],
				userUrls: false,
				local: false,
				calls: ['records.addObligation', 'pets.other'],
				capabilities: [],
			},
		});
		expect(reachOf(own, [own]).worksWith).toEqual([]);
	});
});

describe('uninstalling and restarting', () => {
	it('finds the installed extensions that need one', () => {
		const records = entry('records');
		const list = [
			records,
			entry('pets', { dependsOn: ['records'] }),
			entry('home', { status: 'available', dependsOn: ['records'] }),
			entry('vehicles', { status: 'pending_uninstall', dependsOn: ['records'] }),
		];
		expect(neededBy(records, list).map((e) => e.id)).toEqual(['pets']);
	});

	it('needs a restart while something waits to be installed or uninstalled', () => {
		expect(restartNeeded([entry('a'), entry('b', { status: 'failed' })])).toBe(false);
		expect(restartNeeded([entry('a', { status: 'pending_install' })])).toBe(true);
		expect(restartNeeded([entry('a', { status: 'pending_uninstall' })])).toBe(true);
	});
});
