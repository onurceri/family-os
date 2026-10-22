import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ADMIN, expect, setUpAndSignIn, test } from '../support/fixtures.ts';

test('an admin saves the server key file with the password; a wrong password gets nothing', async ({
	page,
	family,
}) => {
	await setUpAndSignIn(page);
	await page.goto('/settings/backups');
	await page.getByTestId('key-file-save').click();
	const dialog = page.getByRole('dialog', { name: 'Save the key file' });

	await dialog.getByLabel('Your password').fill('not the right password');
	await dialog.getByRole('button', { name: 'Save the key file' }).click();
	await expect(dialog.getByText('That is not your password.')).toBeVisible();

	const download = page.waitForEvent('download');
	await dialog.getByLabel('Your password').fill(ADMIN.password);
	await dialog.getByRole('button', { name: 'Save the key file' }).click();
	const file = await download;
	const saved = await readFile((await file.path()) ?? '', 'utf8');
	// Compared without printing either side: the file is the master key.
	expect(saved === (await readFile(join(family.dataDir, 'secret'), 'utf8'))).toBe(true);
});
