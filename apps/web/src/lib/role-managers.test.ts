import { describe, expect, it } from 'vitest';
import { roleManagersOf } from './role-managers.js';

describe('who may change what roles allow', () => {
	const roles = [
		{ id: 'admin', capabilities: ['core.roles.manage', 'calendar.edit'] },
		{ id: 'role_grownups', capabilities: ['core.roles.manage'] },
		{ id: 'member', capabilities: ['calendar.edit'] },
	];

	it('is every active member whose role holds the right, in the family order', () => {
		const members = [
			{ id: 'nina', roleId: 'member' },
			{ id: 'mara', roleId: 'admin' },
			{ id: 'old', roleId: 'admin', archived: true },
			{ id: 'tom', roleId: 'role_grownups' },
		];
		expect(roleManagersOf(roles, members).map((m) => m.id)).toEqual(['mara', 'tom']);
	});

	it('is no one when no role holds it or the roles are unknown', () => {
		expect(roleManagersOf([], [{ id: 'mara', roleId: 'admin' }])).toEqual([]);
	});
});
