import { expect, setUpAndSignIn, test } from '../support/fixtures.ts';

// The prepared family has every offered extension except pets (support/global-setup.ts).
test('an admin installs Pets from Settings, restarts, and finds it in the navigation', async ({
	page,
}) => {
	await setUpAndSignIn(page);
	await page.goto('/more');
	await expect(page.getByRole('link', { name: 'Vehicles' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Pets' })).toHaveCount(0);

	await page.goto('/settings/extensions');
	await page.getByTestId('available-extensions').getByRole('button', { name: 'Pets' }).click();
	// Before installing, the family sees what it reaches: it adds permissions for roles.
	const panel = page.getByTestId('extension-panel');
	await expect(panel.getByText('Adds 2 permissions for roles')).toBeVisible();
	await page.getByRole('button', { name: 'Install', exact: true }).click();

	// It waits for a restart, which is now the page's one action.
	await expect(page.getByTestId('installed-extensions')).toContainText(
		'Installs when FamilyOS restarts',
	);
	await page.getByTestId('restart-now').click();
	await expect(page.getByTestId('restarting')).toBeVisible();

	// The page reloads by itself once the server is back, running Pets.
	await expect(page.getByTestId('restart-now')).toHaveCount(0, { timeout: 30_000 });
	await expect(page.getByRole('switch', { name: /^Pets/ })).toBeChecked({ timeout: 30_000 });
	await page.goto('/more');
	await page.getByRole('link', { name: 'Pets' }).click();
	await expect(page).toHaveURL(/\/pets$/);
});
