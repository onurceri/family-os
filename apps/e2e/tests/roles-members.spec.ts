import { api, expect, setUpAndSignIn, test } from '../support/fixtures.ts';
import { createMember, signInAs } from '../support/members.ts';

type Members = { id: string; displayName: string; roleId: string }[];

const ADMIN_ONLY_ENTRIES = {
	family: ['Members', 'Roles', 'Devices', 'Extensions'],
	ai: ['Provider & models', 'Auto-approval'],
	system: ['Backups'],
};

test('a plain member sees no admin entries and is refused by the admin-only API', async ({
	page,
	browser,
	family,
}) => {
	await setUpAndSignIn(page);
	await createMember(page, {
		name: 'Ece',
		role: 'member',
		email: 'ece@example.com',
		password: 'another horse battery',
	});

	const custom = await api<{ output: { id: string } }>(
		page,
		'POST',
		'/api/v1/actions/core.createRole',
		{ name: 'Helper', base: 'member', overrides: {} },
	);

	// Admins have the entries; they are the control for the checks below.
	for (const [group, names] of Object.entries(ADMIN_ONLY_ENTRIES)) {
		await page.goto(`/more/${group}`);
		for (const name of names)
			await expect(page.getByRole('link', { name, exact: true }), name).toBeVisible();
	}

	const { context, page: phone } = await signInAs(browser, family, {
		email: 'ece@example.com',
		password: 'another horse battery',
	});
	await phone.goto('/more');
	await expect(phone.getByRole('heading', { name: 'More' })).toBeVisible();
	// No door into Family, AI or System, and their pages of rows are empty for her.
	await expect(phone.getByRole('link', { name: /^(Family|AI|System)/ })).toHaveCount(0);
	for (const group of Object.keys(ADMIN_ONLY_ENTRIES)) {
		await phone.goto(`/more/${group}`);
		await expect(phone.getByRole('heading', { name: 'More' })).toBeVisible();
	}

	// The pages themselves send her home.
	for (const path of ['/settings/members', '/settings/roles', '/settings/auto-approval']) {
		await phone.goto(path);
		await expect(phone).toHaveURL(/\/$/);
	}

	// And the API refuses, whatever the UI shows.
	const origin = family.url;
	const post = async (action: string, data: unknown) =>
		(
			await phone.request.fetch(`${origin}/api/v1/actions/${action}`, {
				method: 'POST',
				headers: { origin },
				data,
			})
		).status();
	expect(await post('core.createMember', { displayName: 'Intruder', roleId: 'admin' })).toBe(403);
	expect(await post('core.createRole', { name: 'Sneaky', base: 'member', overrides: {} })).toBe(
		403,
	);
	expect(
		await post('core.updateRole', { id: custom.output.id, name: 'Hacked', overrides: {} }),
	).toBe(403);
	expect(
		await post('core.updateMember', {
			memberId: (await api<Members>(phone, 'GET', '/api/v1/core/members')).find(
				(m) => m.displayName === 'Ece',
			)?.id,
			roleId: 'admin',
		}),
	).toBe(403);
	expect(
		await post('core.setAutoApproval', { actionId: 'lists.addShoppingItems', setting: null }),
	).toBe(403);
	expect(await post('core.setFeatureEnabled', { extensionId: 'calendar', enabled: false })).toBe(
		403,
	);

	// Nothing changed: still one admin and her own role.
	const members = await api<Members>(page, 'GET', '/api/v1/core/members');
	expect(members.map((m) => m.displayName).sort()).toEqual(['Deniz', 'Ece']);
	expect(members.find((m) => m.displayName === 'Ece')?.roleId).toBe('member');
	await context.close();
});
