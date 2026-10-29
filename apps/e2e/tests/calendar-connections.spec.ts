import { api, expect, nextWeek, setUpAndSignIn, test } from '../support/fixtures.ts';

test('a phone calendar address works until it is removed, and a private subscription is refused', async ({
	page,
}) => {
	await setUpAndSignIn(page);
	await api(page, 'POST', '/api/v1/actions/calendar.createEvent', {
		title: 'Dentist',
		date: nextWeek(),
		startTime: '10:00',
	});

	await page.goto('/calendar');
	await page.getByRole('link', { name: 'Calendars & tags' }).click();
	await expect(page).toHaveURL(/\/settings\/calendars$/);
	await page.goto('/settings/calendar-feed');
	await expect(page.getByRole('heading', { name: 'Calendar on my phone', level: 1 })).toBeVisible();

	await page.getByRole('button', { name: 'Add an address' }).click();
	await page.getByLabel('Where will you use it? (optional)').fill('Kitchen tablet');
	await page.getByRole('button', { name: 'Create address' }).click();
	const address = page.getByLabel('Your calendar address');
	await expect(address).toBeVisible();
	const url = await address.inputValue();
	expect(url).toMatch(/\/api\/v1\/calendar\/feed\/[A-Za-z0-9_-]{43}\.ics$/);
	await expect(page.getByRole('link', { name: 'Open in the calendar app' })).toHaveAttribute(
		'href',
		/^webcal:\/\//,
	);

	// Anyone with the address reads the calendar, without signing in.
	const anonymous = await page.context().browser()?.newContext();
	const open = await anonymous?.request.get(url);
	expect(open?.status()).toBe(200);
	expect(open?.headers()['content-type']).toBe('text/calendar; charset=utf-8');
	expect(await open?.text()).toContain('SUMMARY:Dentist');

	await page.getByRole('button', { name: 'I have saved it' }).click();
	await expect(page.getByText('Kitchen tablet · Deniz')).toBeVisible();
	const list = page.getByRole('region', { name: 'Your addresses' });
	await list.getByRole('button', { name: 'Remove' }).click();
	await list.getByRole('button', { name: 'Tap again to remove' }).click();
	await expect(page.getByText('No addresses yet.')).toBeVisible();
	expect((await anonymous?.request.get(url))?.status()).toBe(404);
	await anonymous?.close();

	// Removing an address while it is still shown takes it off the screen: it no longer works.
	await page.getByRole('button', { name: 'Add an address' }).click();
	await page.getByRole('button', { name: 'Create address' }).click();
	await expect(page.getByLabel('Your calendar address')).toBeVisible();
	await list.getByRole('button', { name: 'Remove' }).click();
	await list.getByRole('button', { name: 'Tap again to remove' }).click();
	await expect(page.getByText('No addresses yet.')).toBeVisible();
	await expect(page.getByLabel('Your calendar address')).toHaveCount(0);

	// A subscription to an address inside the network is refused unless allowed.
	await page.goto('/settings/calendars');
	await page.getByRole('button', { name: 'Add subscription' }).click();
	await page.getByLabel('Name', { exact: true }).fill('Router');
	await page.getByLabel('Calendar address').fill('https://127.0.0.1/private.ics?key=secret');
	await page.getByRole('dialog').getByRole('button', { name: 'Add subscription' }).click();
	const subs = page.getByRole('region', { name: 'Calendar subscriptions' });
	await expect(subs.getByText('Router')).toBeVisible();
	await expect(subs.getByText(/points into a private network/)).toBeVisible();
	await expect(page.getByText('key=secret')).toHaveCount(0);

	// Editing: rename and recolour; the stored address is never shown.
	await subs.getByRole('button', { name: 'Router' }).click();
	const edit = page.getByRole('form', { name: 'Edit Router' });
	await expect(edit.getByLabel('New calendar address (optional)')).toHaveValue('');
	await expect(edit.getByText('Leave empty to keep the current address (127.0.0.1)')).toBeVisible();
	await edit.getByLabel('Name', { exact: true }).fill('Home router');
	await edit.getByRole('radio').last().locator('xpath=..').click();
	await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
	await expect(page.getByText('Subscription saved')).toBeVisible();
	await expect(subs.getByText('Home router')).toBeVisible();
	await expect(subs.getByText('Router', { exact: true })).toHaveCount(0);
});
