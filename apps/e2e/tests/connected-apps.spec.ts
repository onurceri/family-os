import { api, expect, setUpAndSignIn, test } from '../support/fixtures.ts';
import { createMember, signInAs } from '../support/members.ts';

/** A call with an app key as a bearer, the way a program outside makes it. */
async function withKey(
	url: string,
	secret: string,
	path: string,
	headers: Record<string, string> = {},
) {
	const res = await fetch(`${url}${path}`, {
		headers: { authorization: `Bearer ${secret}`, ...headers },
	});
	return res.status;
}

test('an admin adds an app, sees its key once, and revokes it; a member has no say over apps', async ({
	page,
	browser,
	family,
}) => {
	await setUpAndSignIn(page);
	const login = { email: 'ece@example.com', password: 'another horse battery' };
	await createMember(page, { name: 'Ece', role: 'member', ...login });

	await page.goto('/settings/connected-apps');
	await page.getByRole('button', { name: 'Add an app' }).click();
	const panel = page.getByTestId('app-panel');
	await panel.getByLabel('Name', { exact: true }).fill('Home Assistant');
	await panel.getByRole('radio', { name: 'Changes wait for approval' }).click();
	await page.getByRole('button', { name: 'Add app', exact: true }).click();

	// The key is shown once, with the address to give the app.
	const secret = (await panel.getByTestId('app-secret').textContent()) ?? '';
	expect(secret).toMatch(/^famos_/);
	await panel.getByRole('button', { name: 'I have copied it' }).click();
	await expect(page.getByText('Home Assistant').first()).toBeVisible();
	await expect(page.getByText('Changes wait for approval').first()).toBeVisible();

	// An app key works at no door of the app's own: not the API, which takes a session.
	expect(await withKey(family.url, secret, '/api/v1/core/members')).toBe(400);
	expect(await withKey(family.url, secret, '/mcp')).not.toBe(200);

	// A member neither sees the section nor can use the routes.
	const ece = await signInAs(browser, family, login);
	await ece.page.goto('/settings/connected-apps');
	await expect(ece.page.getByRole('button', { name: 'Add an app' })).toHaveCount(0);
	expect(await api(ece.page, 'GET', '/api/v1/apps').catch((e: unknown) => String(e))).toContain(
		'403',
	);
	await ece.context.close();

	// Revoking ends the app: its row goes from the list.
	await page.goto('/settings/connected-apps');
	await page.getByRole('button', { name: /Home Assistant/ }).click();
	await expect(page.getByTestId('app-panel')).toBeVisible();
	await page.getByRole('button', { name: 'Revoke app' }).click();
	await page.getByRole('button', { name: 'Tap again to revoke' }).click();
	await expect(page.getByText('No apps yet')).toBeVisible();
});
