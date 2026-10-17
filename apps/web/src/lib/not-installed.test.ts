import { describe, expect, it } from 'vitest';
import { notInstalledOwner } from './not-installed.js';

const known = [
	{ id: 'pets', status: 'available' },
	{ id: 'kitchen', status: 'pending_install' },
	{ id: 'chores', status: 'loaded' },
	{ id: 'home', status: 'pending_uninstall' },
];

describe('notInstalledOwner', () => {
	it('finds the extension a path would belong to when it is not installed', () => {
		expect(notInstalledOwner('/pets', known)?.id).toBe('pets');
		expect(notInstalledOwner('/pets/pet_1/edit', known)?.id).toBe('pets');
		expect(notInstalledOwner('/kitchen', known)?.id).toBe('kitchen');
	});

	it('says nothing for an installed extension, a path nobody owns or the root', () => {
		expect(notInstalledOwner('/chores', known)).toBeUndefined();
		expect(notInstalledOwner('/home', known)).toBeUndefined();
		expect(notInstalledOwner('/nowhere', known)).toBeUndefined();
		expect(notInstalledOwner('/', known)).toBeUndefined();
	});
});
