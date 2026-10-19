import { describe, expect, it } from 'vitest';
import { byName, settingsByName } from './nav-order.js';

const names: Record<string, string> = {
	nav_profile: 'Profile & sign-in',
	nav_appearance: 'Appearance',
	nav_notifications: 'Notifications',
	nav_memory: 'Assistant memory',
	nav_connected_apps: 'Connected apps',
	nav_members: 'Members',
	nav_roles: 'Roles',
	nav_devices_displays: 'Devices',
	nav_extensions: 'Extensions',
	nav_language_region: 'Language & region',
	'ha:nav': 'Home Assistant',
};
const name = (key: string) => names[key] ?? key;

const SECTIONS = ['you', 'family'] as const;
type Part = (typeof SECTIONS)[number];
const page = (id: string, labelKey: string, section: Part, first = false) => ({
	id,
	labelKey,
	section,
	first,
});
const items = [
	page('core.members', 'nav_members', 'family'),
	page('core.roles', 'nav_roles', 'family'),
	page('ha', 'ha:nav', 'family'),
	page('core.extensions', 'nav_extensions', 'family'),
	page('core.language', 'nav_language_region', 'family'),
	page('core.devices', 'nav_devices_displays', 'family'),
	page('core.appearance', 'nav_appearance', 'you'),
	page('core.notifications', 'nav_notifications', 'you'),
	page('core.account', 'nav_profile', 'you', true),
	page('core.memory', 'nav_memory', 'you'),
	page('core.apps', 'nav_connected_apps', 'you'),
];

function section(label: (key: string) => string, locale: string, id: Part): string[] {
	const parts = settingsByName(items, SECTIONS, 'family', byName(label, locale));
	return parts.find((s) => s.section === id)?.items.map((i) => label(i.labelKey)) ?? [];
}

describe('settings list', () => {
	it('is alphabetical inside each part, with Profile first in You', () => {
		expect(section(name, 'en', 'you')).toEqual([
			'Profile & sign-in',
			'Appearance',
			'Assistant memory',
			'Connected apps',
			'Notifications',
		]);
		const family = section(name, 'en', 'family');
		expect(family).toEqual([...family].sort((a, b) => a.localeCompare(b, 'en')));
		expect(family).toContain('Home Assistant');
	});

	it("follows the reader's language", () => {
		const turkish: Record<string, string> = {
			nav_members: 'Üyeler',
			nav_roles: 'Roller',
			nav_extensions: 'Eklentiler',
		};
		const family = section((key) => turkish[key] ?? name(key), 'tr', 'family');
		expect(family.indexOf('Eklentiler')).toBeLessThan(family.indexOf('Roller'));
		expect(family.indexOf('Roller')).toBeLessThan(family.indexOf('Üyeler'));
	});
});
