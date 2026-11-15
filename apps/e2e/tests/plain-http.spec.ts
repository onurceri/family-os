import { api, expect, setUpAndSignIn, test } from '../support/fixtures.ts';

// A family opens FamilyOS at http://192.168.…: the browser calls that an insecure context, where
// `crypto.randomUUID` and `navigator.clipboard` do not exist. `famos.test` is such an origin
// (only localhost counts as secure), mapped to the local server.
test.use({
	freshFamily: true,
	insecureHost: true,
	launchOptions: { args: ['--host-resolver-rules=MAP famos.test 127.0.0.1'] },
});

type ShoppingItem = { id: string; title: string; doneAt: number | null };

async function shoppingItems(page: Parameters<typeof api>[0]) {
	const lists = await api<{ id: string }[]>(page, 'GET', '/api/v1/lists/shopping/lists');
	return api<ShoppingItem[]>(page, 'GET', `/api/v1/lists/shopping/lists/${lists[0]?.id}/items`);
}

test('shopping: adding and ticking work on a plain-http address', async ({ page }) => {
	await setUpAndSignIn(page);
	await page.goto('/lists/shopping');
	expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
	await expect(
		page.getByRole('group', { name: 'Shopping lists' }).getByText('Groceries', { exact: true }),
	).toBeVisible();

	const composer = page.getByRole('textbox', { name: 'Add an item' });
	await composer.fill('bread');
	await composer.press('Enter');
	const bread = page.getByRole('button', { name: /^Bread/ });
	await expect(bread).toBeVisible();
	expect((await shoppingItems(page)).map((i) => [i.title, i.doneAt])).toEqual([['Bread', null]]);

	await bread.click();
	await expect
		.poll(async () => (await shoppingItems(page)).map((i) => [i.title, i.doneAt !== null]))
		.toEqual([['Bread', true]]);
});
