import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import { filterSettings } from './settings-search.js';

const groups = [
	{ section: 'you', items: ['nav_profile', 'nav_appearance'] },
	{ section: 'family', items: ['nav_members', 'nav_devices_displays', 'nav_photos_weather'] },
	{ section: 'system', items: ['nav_backups'] },
];
/** An extension's page is named from its own catalog. */
const labels: Record<string, string> = { ...en, nav_photos_weather: 'Photos and weather' };
const label = (key: string) => labels[key] ?? key;
const found = (query: string) => filterSettings(groups, query, label);

describe('settings search', () => {
	it('lists everything without a query', () => {
		expect(found('  ').map((g) => g.items.length)).toEqual([2, 3, 1]);
	});

	it('finds Photos and weather by either word, in any case', () => {
		for (const query of ['weather', 'Photos', ' PHOTO '])
			expect(found(query)).toEqual([{ section: 'family', items: ['nav_photos_weather'] }]);
	});

	it('finds Devices, and drops the groups without a match', () => {
		expect(found('devic')).toEqual([{ section: 'family', items: ['nav_devices_displays'] }]);
		expect(found('nothing like this')).toEqual([]);
	});
});
