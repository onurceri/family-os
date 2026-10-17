import { describe, expect, it } from 'vitest';
import { entryFor, OPEN, type PageEntry, pageAccess } from './page-access.js';

const entries: PageEntry[] = [
	{ path: '/settings/members', labelKey: 'nav_members' },
	{ path: '/settings/ai', labelKey: 'nav_ai' },
	{ path: '/settings/ai/usage', labelKey: 'nav_ai_usage', alsoOn: ['/settings/ai/activity'] },
	{ path: '/vehicles', labelKey: 'vehicles:nav' },
	{
		path: '/lists',
		labelKey: 'lists:nav',
		children: [{ path: '/lists/shopping', labelKey: 'lists:shopping' }],
	},
];
const holds =
	(...held: string[]) =>
	(capability: string) =>
		held.includes(capability);

describe('pageAccess', () => {
	it('opens a page that asks for nothing to everyone', () => {
		expect(pageAccess({ path: '/lists', page: {}, entries, can: holds() })).toBe(OPEN);
		expect(pageAccess({ path: '/lists', page: undefined, entries, can: holds() })).toBe(OPEN);
	});

	it('opens a page to those who hold what it asks for', () => {
		const page = { requires: 'core.members.manage' };
		expect(
			pageAccess({ path: '/settings/members', page, entries, can: holds('core.members.manage') }),
		).toBe(OPEN);
	});

	it('closes it to the others, with the name of its entry', () => {
		const page = { requires: 'core.members.manage' };
		expect(
			pageAccess({ path: '/settings/members', page, entries, can: holds('core.roles.manage') }),
		).toEqual({ open: false, labelKey: 'nav_members' });
	});

	it('names a record page by the list it belongs to', () => {
		expect(
			pageAccess({
				path: '/vehicles/veh_1',
				page: { requires: 'vehicles.view' },
				entries,
				can: holds(),
			}),
		).toEqual({ open: false, labelKey: 'vehicles:nav' });
	});

	it('closes a page without an entry too, without a name', () => {
		expect(
			pageAccess({ path: '/share', page: { requires: 'inbox.share' }, entries, can: holds() }),
		).toEqual({ open: false, labelKey: undefined });
	});
});

describe('entryFor', () => {
	it('takes the longest entry the page lies under', () => {
		expect(entryFor(entries, '/settings/ai/usage')?.labelKey).toBe('nav_ai_usage');
		expect(entryFor(entries, '/settings/ai/privacy')?.labelKey).toBe('nav_ai');
	});

	it('counts a page listed in `alsoOn` and the children of an entry', () => {
		expect(entryFor(entries, '/settings/ai/activity')?.labelKey).toBe('nav_ai_usage');
		expect(entryFor(entries, '/lists/shopping')?.labelKey).toBe('lists:shopping');
	});

	it('does not take a path that only starts with the same letters', () => {
		expect(entryFor(entries, '/vehicles-old')).toBeUndefined();
	});
});
