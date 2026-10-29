import { api, expect, setUpAndSignIn, test } from '../support/fixtures.ts';
import { createMember, signInAs } from '../support/members.ts';

type Members = { id: string; displayName: string; roleId: string }[];

const ADMIN_ONLY_ENTRIES = {
	family: ['Members', 'Roles', 'Devices and displays', 'Extensions'],
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

	// The pages themselves (the app's and an extension's) say who they are for, and offer Today.
	for (const path of [
		'/settings/members',
		'/settings/roles',
		'/settings/auto-approval',
		'/settings/photos-weather',
	]) {
		await phone.goto(path);
		await expect(
			phone.getByRole('heading', { name: /^This page is for people who may use / }),
			path,
		).toBeVisible();
		await expect(phone).toHaveURL(new RegExp(`${path}$`));
		await expect(phone.getByRole('link', { name: 'Back to Today' })).toHaveAttribute('href', '/');
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

test('controls are shown only for what a role may do, and suggestions say so first', async ({
	page,
	browser,
	family,
}) => {
	await setUpAndSignIn(page);
	const helper = await api<{ output: { id: string } }>(
		page,
		'POST',
		'/api/v1/actions/core.createRole',
		{ name: 'Shopping helper', base: 'guest', overrides: { 'lists.shopping.edit': true } },
	);
	const login = (name: string) => ({
		email: `${name}@example.com`,
		password: 'another horse battery',
	});
	await createMember(page, { name: 'Nina', role: helper.output.id, ...login('nina') });
	const leo = await createMember(page, { name: 'Leo', role: 'supervised', ...login('leo') });
	await api(page, 'POST', '/api/v1/actions/chores.createChore', {
		title: 'Empty the dishwasher',
		startDate: new Date().toISOString().slice(0, 10),
		assigneeIds: [],
		rotation: 'round_robin',
	});
	await api(page, 'POST', '/api/v1/actions/lists.addTask', {
		title: 'Pack the bag',
		assigneeId: leo,
	});

	// Nina may add and tick shopping items, nothing else: the rest only looks.
	const nina = await signInAs(browser, family, login('nina'));
	await nina.page.goto('/calendar');
	await expect(nina.page.getByTestId('view-only')).toBeVisible();
	await expect(nina.page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
	await nina.page.goto('/board');
	await expect(nina.page.getByTestId('view-only')).toBeVisible();
	await nina.page.goto('/chores');
	await expect(nina.page.getByTestId('chore-status')).toHaveCount(1);
	await expect(nina.page.getByRole('button', { name: /^Mark/ })).toHaveCount(0);
	await nina.page.goto('/lists/shopping');
	await expect(nina.page.getByTestId('view-only')).toHaveCount(0);
	await expect(nina.page.getByRole('button', { name: 'New list' })).toHaveCount(0);
	await nina.context.close();

	// Leo may suggest: the sheet says so under its title and its button says what it does.
	const child = await signInAs(browser, family, login('leo'));
	await child.page.goto('/calendar');
	await child.page.getByRole('button', { name: 'Add' }).last().click();
	await expect(child.page.getByTestId('side-panel-note')).toBeVisible();
	await expect(child.page.getByRole('button', { name: 'Send for approval' })).toBeVisible();
	await child.page.keyboard.press('Escape');
	// His own task is saved at once: the sheet must not say it waits for someone.
	await child.page.goto('/lists/tasks');
	await child.page.getByText('Pack the bag').click();
	await expect(child.page.getByRole('dialog')).toBeVisible();
	await expect(child.page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
	await expect(child.page.getByTestId('side-panel-note')).toHaveCount(0);
	await child.context.close();
});
