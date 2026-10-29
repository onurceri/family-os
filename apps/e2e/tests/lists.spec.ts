import { api, expect, FAMILY_TIME_ZONE, setUpAndSignIn, test } from '../support/fixtures.ts';
import { createMember } from '../support/members.ts';

type ShoppingItem = { id: string; title: string; quantity: string | null; doneAt: number | null };
type Task = {
	id: string;
	title: string;
	assigneeId: string | null;
	dueDate: string | null;
	doneAt: number | null;
};

const dayFromNow = (days: number) =>
	new Intl.DateTimeFormat('en-CA', {
		timeZone: FAMILY_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date(Date.now() + days * 86_400_000));

async function shoppingItems(page: Parameters<typeof api>[0]) {
	const lists = await api<{ id: string }[]>(page, 'GET', '/api/v1/lists/shopping/lists');
	return api<ShoppingItem[]>(page, 'GET', `/api/v1/lists/shopping/lists/${lists[0]?.id}/items`);
}

test('shopping: add, edit, tick, clear what was bought, and delete', async ({ page }) => {
	await setUpAndSignIn(page);
	await page.goto('/lists/shopping');
	await expect(page.getByText('Nothing to buy yet.')).toBeVisible();
	// Adding needs the list itself to be loaded (its name shows), not just the empty page.
	await expect(
		page.getByRole('group', { name: 'Shopping lists' }).getByText('Groceries', { exact: true }),
	).toBeVisible();

	// One line, several items; Enter adds, a leading amount becomes the quantity and what follows it
	// starts with a capital.
	const composer = page.getByRole('textbox', { name: 'Add an item' });
	await composer.fill('2 kg tomatoes, bread, milk');
	await composer.press('Enter');
	const tomatoes = page.getByRole('button', { name: /^Tomatoes/ });
	await expect(tomatoes).toBeVisible();
	await expect(tomatoes).toContainText('2 kg');
	await expect(page.getByRole('button', { name: /^Bread/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /^Milk/ })).toBeVisible();
	await expect(composer).toHaveValue('');
	expect((await shoppingItems(page)).map((i) => [i.title, i.quantity])).toEqual(
		expect.arrayContaining([
			['Tomatoes', '2 kg'],
			['Bread', null],
			['Milk', null],
		]),
	);

	// Edit the name and the quantity of one item: the row's menu opens the sheet (panel on desktop).
	await page.getByRole('button', { name: 'Options for Bread' }).click();
	await page.getByRole('button', { name: 'Edit item' }).click();
	await page.getByLabel('Title').fill('sourdough bread');
	await page.getByLabel('Quantity').fill('2');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('button', { name: /^sourdough bread/ })).toContainText('2');
	await expect(page.getByRole('button', { name: /^Bread/ })).toHaveCount(0);
	expect((await shoppingItems(page)).find((i) => i.title === 'sourdough bread')?.quantity).toBe(
		'2',
	);

	// Tick two items: they move to "In the cart" (folded) and stay ticked.
	await page.getByRole('button', { name: /^Tomatoes/ }).click();
	await page.getByRole('button', { name: /^Milk/ }).click();
	const bought = page.getByRole('region', { name: 'In the cart' });
	await expect(bought.getByRole('button', { name: /^In the cart/ })).toContainText('2');
	await expect(bought.getByRole('button', { name: /^Tomatoes/ })).toHaveCount(0);
	await bought.getByRole('button', { name: /^In the cart/ }).click();
	await expect(bought.getByRole('button', { name: /^Tomatoes/ })).toHaveAttribute(
		'aria-pressed',
		'true',
	);
	await expect(bought.getByRole('button', { name: /^Milk/ })).toBeVisible();
	await expect
		.poll(async () => (await shoppingItems(page)).filter((i) => i.doneAt !== null).length)
		.toBe(2);

	// Unticking puts one back.
	await bought.getByRole('button', { name: /^Milk/ }).click();
	await expect(bought.getByRole('button', { name: /^Milk/ })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Milk/ })).toHaveAttribute(
		'aria-pressed',
		'false',
	);

	// Clear what was bought needs a second tap; only the bought item goes.
	await bought.getByRole('button', { name: 'Clear the cart' }).click();
	await expect(bought.getByRole('button', { name: 'Tap again to clear' })).toBeVisible();
	expect(await shoppingItems(page)).toHaveLength(3);
	await bought.getByRole('button', { name: 'Tap again to clear' }).click();
	await expect(page.getByRole('region', { name: 'In the cart' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Tomatoes/ })).toHaveCount(0);
	expect((await shoppingItems(page)).map((i) => i.title).sort()).toEqual([
		'Milk',
		'sourdough bread',
	]);

	// Delete an item from its editor (two taps).
	await page.getByRole('button', { name: 'Options for Milk' }).click();
	await page.getByRole('button', { name: 'Edit item' }).click();
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	await page.getByRole('button', { name: 'Tap again to delete' }).click();
	await expect(page.getByRole('button', { name: /^Milk/ })).toHaveCount(0);
	expect((await shoppingItems(page)).map((i) => i.title)).toEqual(['sourdough bread']);

	// Delete from the row's menu: gone at once, with Undo.
	await page.getByRole('button', { name: 'Options for sourdough bread' }).click();
	await page.getByRole('button', { name: 'Delete item' }).click();
	await expect(page.getByRole('button', { name: /^sourdough bread/ })).toHaveCount(0);
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByRole('button', { name: /^sourdough bread/ })).toBeVisible();
});

test('tasks: create, assign to someone else, set a due date, complete and uncomplete', async ({
	page,
}) => {
	await setUpAndSignIn(page);
	const elif = await createMember(page, { name: 'Elif', role: 'member' });
	const today = dayFromNow(0);
	const tomorrow = dayFromNow(1);
	// The Lists tab opens Shopping at first; the title switches to Tasks, and the tab remembers it.
	const listsTab = page.locator('nav a[href="/lists"]').filter({ visible: true }).first();
	await listsTab.click();
	await expect(page).toHaveURL(/\/lists\/shopping$/);
	await page.getByRole('link', { name: 'Tasks', exact: true }).click();
	await expect(page).toHaveURL(/\/lists\/tasks$/);
	await expect(page.getByText('Nothing to do yet.')).toBeVisible();

	// Quick add: Enter adds a task for anyone, in the "No date" group.
	const composer = page.getByRole('textbox', { name: 'Add a task' });
	await composer.fill('Buy a birthday present');
	await composer.press('Enter');
	const noDate = page.getByRole('region', { name: 'No date' });
	await expect(noDate.getByText('Buy a birthday present')).toBeVisible();
	await expect(noDate).toContainText('Anyone');

	// The full form: "Add details" opens the sheet (panel on desktop) with the typed title.
	await composer.fill('Sign the school form');
	await page.getByRole('button', { name: 'Add details' }).click();
	const sheet = page.getByTestId('side-panel');
	await expect(sheet.getByLabel('Title')).toHaveValue('Sign the school form');
	await sheet.getByRole('button', { name: 'Elif' }).click();
	await sheet.getByLabel('Due date').fill(today);
	await sheet.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByText('Saved')).toBeVisible();

	// It is in the "Today" group, and says who it is for.
	const dueToday = page.getByRole('region', { name: 'Today', exact: true });
	await expect(dueToday.getByText('Sign the school form')).toBeVisible();
	await expect(dueToday).toContainText('Elif');
	const tasks = await api<Task[]>(page, 'GET', '/api/v1/lists/tasks');
	const form = tasks.find((t) => t.title === 'Sign the school form');
	expect(form).toMatchObject({ assigneeId: elif, dueDate: today, doneAt: null });

	// Move the other task to tomorrow and to Elif through its details.
	await page.getByRole('button', { name: /^Buy a birthday present/ }).click();
	await page.getByTestId('side-panel').getByRole('button', { name: 'Elif' }).click();
	await page.getByTestId('side-panel').getByLabel('Due date').fill(tomorrow);
	await page.getByTestId('side-panel').getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved')).toBeVisible();
	// Tomorrow is this week or, on the last day of the family's week, next week.
	const soon = page.getByRole('region', { name: /^(This week|Next week)$/ });
	const moved = soon.getByRole('button', { name: /^Buy a birthday present/ });
	await expect(moved).toContainText('Tomorrow');
	await expect(moved).toContainText('Elif');
	await expect(page.getByRole('region', { name: 'No date' })).toHaveCount(0);

	// The Today page lists the open tasks, what is due first.
	await page.goto('/');
	await expect(page.getByText('Sign the school form')).toBeVisible();
	await expect(page.getByText('Buy a birthday present')).toBeVisible();

	// Complete it on the Tasks page (the Lists tab opens it now): it leaves the open list and
	// moves to "Done" (folded).
	await listsTab.click();
	await expect(page).toHaveURL(/\/lists\/tasks$/);
	await dueToday
		.getByRole('listitem')
		.filter({ hasText: 'Sign the school form' })
		.getByRole('button', { name: 'Mark “Sign the school form” done', pressed: false })
		.click();
	const done = page.getByRole('region', { name: 'Done', exact: true });
	await expect(done.getByRole('button', { name: /^Done/ })).toContainText('1');
	await expect(dueToday.getByText('Sign the school form')).toHaveCount(0);
	await done.getByRole('button', { name: /^Done/ }).click();
	await expect(done.getByText('Sign the school form')).toBeVisible();
	expect(
		(await api<Task[]>(page, 'GET', '/api/v1/lists/tasks')).find((t) => t.id === form?.id)?.doneAt,
	).not.toBeNull();

	// Done tasks are gone from Today.
	await page.goto('/');
	await expect(page.getByText('Sign the school form')).toHaveCount(0);

	// Uncomplete: it is back in "Today" and on the Today page.
	await page.goto('/lists/tasks');
	await page
		.getByRole('region', { name: 'Done', exact: true })
		.getByRole('button', { name: /^Done/ })
		.click();
	await page
		.getByRole('region', { name: 'Done', exact: true })
		.getByRole('button', { name: 'Mark “Sign the school form” done', pressed: true })
		.click();
	await expect(
		page.getByRole('region', { name: 'Today', exact: true }).getByText('Sign the school form'),
	).toBeVisible();
	await expect(page.getByRole('region', { name: 'Done', exact: true })).toHaveCount(0);
	expect(
		(await api<Task[]>(page, 'GET', '/api/v1/lists/tasks')).find((t) => t.id === form?.id)?.doneAt,
	).toBeNull();
	await page.goto('/');
	await expect(page.getByText('Sign the school form')).toBeVisible();

	// Delete from the details (two taps).
	await page.goto('/lists/tasks');
	await page.getByRole('button', { name: /^Sign the school form/ }).click();
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	await page.getByRole('button', { name: 'Tap again to delete' }).click();
	await expect(page.getByText('Sign the school form')).toHaveCount(0);
});
