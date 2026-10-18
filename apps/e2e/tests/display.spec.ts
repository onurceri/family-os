import { pairDisplay } from '../support/display.ts';
import { api, expect, setUpAndSignIn, test } from '../support/fixtures.ts';
import { createMember } from '../support/members.ts';
import { day, standAt } from '../support/today.ts';

/**
 * The family display: paired with a code, Today in family mode without a
 * person, and only what it was granted: no actions, no other areas, no PIN sign-in or profiles.
 */

test('a wall display pairs with a code, shows Today in family mode, follows live changes and is revoked', async ({
	page,
	browser,
	family,
}) => {
	await setUpAndSignIn(page);
	await api(page, 'POST', '/api/v1/actions/calendar.createEvent', {
		title: 'Piano lesson',
		date: day(0),
		startTime: '15:45',
		endTime: '16:30',
		location: 'Music school',
	});
	await api(page, 'POST', '/api/v1/actions/lists.addShoppingItems', {
		items: [{ title: 'Oat milk' }, { title: 'Bread' }],
	});

	// The display is another browser: landscape, no one signed in.
	const wall = await browser.newContext({
		baseURL: family.url,
		viewport: { width: 1280, height: 800 },
		isMobile: false,
		hasTouch: false,
		locale: 'en-US',
		timezoneId: 'Europe/Istanbul',
	});
	const display = await wall.newPage();
	await display.goto('/display');
	await expect(display.getByRole('heading', { name: 'Connect this screen' })).toBeVisible();
	// The code arrives from the server a moment after the page opens.
	await expect(display.getByTestId('pair-code')).toHaveText(/^\s*[A-Z2-9]{4}-[A-Z2-9]{4}\s*$/);
	await expect(display.getByTestId('pair-qr').locator('svg path')).toHaveCount(1);
	const code = (await display.getByTestId('pair-code').textContent())?.trim() ?? '';
	await expect(display.getByTestId('pair-address')).toContainText(`/settings/devices?code=${code}`);

	// An admin adds it from Settings: Add a device asks what it is, then walks through the steps.
	// What makes up the day is ticked at first, chores among it; the waiting-suggestions pill and
	// names are off.
	await page.goto('/settings/devices');
	await page.getByRole('button', { name: 'Add a device' }).click();
	const sheet = page.getByTestId('add-device');
	await expect(sheet.getByText('What are you adding?')).toBeVisible();
	await sheet.getByRole('button', { name: /A screen for the wall or a TV/ }).click();
	// The e2e server runs on localhost: no address a screen could use, and the note says so.
	await expect(sheet.getByTestId('loopback-note')).toContainText('only on this computer');
	await sheet.getByRole('button', { name: 'Next' }).click();
	await sheet.getByLabel('Code on the screen').fill(code);
	await sheet.getByRole('button', { name: 'Next' }).click();
	await expect(sheet.getByText(`Code ${code}`)).toBeVisible();
	await expect(sheet.getByLabel('See the calendar')).toBeChecked();
	await expect(sheet.getByLabel('See the chores and whose turn it is')).toBeChecked();
	await expect(sheet.getByLabel('See how many suggestions are waiting')).not.toBeChecked();
	await sheet.getByLabel('Name of the screen').fill('Hallway');
	await sheet.getByRole('button', { name: 'Connect the screen' }).click();
	// Connected only once the screen has claimed the code, on its next poll (every five seconds).
	await expect(sheet.getByTestId('pairing-status')).toHaveAttribute('data-state', 'connected', {
		timeout: 20_000,
	});
	await expect(sheet.getByText('Hallway is connected.')).toBeVisible();
	await sheet.getByRole('button', { name: 'Close' }).click();

	// The display picks it up on its next poll and composes Today once, in the family's style. A
	// poll that fails under load retries after 15 s, so allow for one retry.
	const body = display.getByTestId('today-body');
	await expect(body).toHaveAttribute('data-settled', 'true', { timeout: 40_000 });
	// The afternoon, for the hero's countdown (the pairing code's ten minutes run on the real clock).
	await standAt(display, '15:20');
	await display.reload();
	await expect(body).toHaveAttribute('data-settled', 'true');
	await expect(body).toHaveAttribute('data-layout', 'broadsheet');
	await expect(display.getByTestId('next-up')).toContainText('Piano lesson');
	await expect(display.getByTestId('next-up')).toHaveAccessibleName(/Piano lesson.*in 25 minutes/);
	await expect(display.getByTestId('big-number')).toContainText('2');
	await expect(display.getByText('Hallway', { exact: true })).toBeVisible();
	// Family mode: no person, nothing to act on, nowhere to go.
	await expect(display.getByTestId('day-sentence')).toHaveCount(0);
	await expect(display.getByTestId('needs-you')).toBeHidden();
	await expect(display.getByRole('link')).toHaveCount(0);
	await expect(display.getByRole('button')).toHaveCount(0);
	await expect(display.getByText('Deniz')).toHaveCount(0);
	// Live: a new event appears without reloading.
	await api(page, 'POST', '/api/v1/actions/calendar.createEvent', {
		title: 'Football practice',
		date: day(0),
		startTime: '17:00',
		endTime: '18:00',
	});
	await expect(display.getByText('Football practice')).toBeVisible({ timeout: 10_000 });

	// It stays signed out: a display is not a person.
	expect((await wall.request.get('/api/v1/core/me')).status()).toBe(401);
	expect((await wall.request.get('/api/v1/core/profiles')).status()).toBe(401);

	// Removing it returns it to the pairing screen.
	await page.getByTestId('device-list').getByRole('button', { name: 'Hallway' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Tap again to remove' }).click();
	await expect(display.getByRole('heading', { name: 'Connect this screen' })).toBeVisible({
		timeout: 20_000,
	});
	expect(
		(await wall.request.get('/api/v1/calendar/occurrences?from=2026-01-01&to=2026-01-02')).status(),
	).toBe(401);
	await wall.close();
});

test('a tablet the family shares becomes a family device from Add a device', async ({ page }) => {
	await setUpAndSignIn(page);
	await page.goto('/settings/devices');
	await expect(page.getByText('This device is not a family device.')).toBeVisible();
	await page.getByRole('button', { name: 'Add a device' }).click();
	const sheet = page.getByTestId('add-device');
	await sheet.getByRole('button', { name: /A tablet or phone the family shares/ }).click();
	await sheet.getByRole('button', { name: 'Next' }).click();
	await expect(sheet.getByText('Sign in there with your own email and password.')).toBeVisible();
	await sheet.getByRole('button', { name: 'Next' }).click();
	// The admin is on that tablet now, so the step is the button itself.
	await sheet.getByLabel('Device name').fill('Kitchen tablet');
	await sheet.getByRole('button', { name: 'Make this a family device' }).click();
	await expect(sheet.getByText('Kitchen tablet is a family device.')).toBeVisible();
	await sheet.getByRole('button', { name: 'Close' }).click();
	await expect(page.getByText('This device is the family device “Kitchen tablet”.')).toBeVisible();
	await expect(
		page.getByTestId('device-list').getByRole('button', { name: 'Kitchen tablet' }),
	).toContainText('Family device');
	const devices = await api<{ name: string; kind: string }[]>(page, 'GET', '/api/v1/core/devices');
	expect(devices.map((d) => [d.name, d.kind])).toEqual([['Kitchen tablet', 'family']]);
});

test('a display only reads what it was granted: no actions, no other areas, no PIN sign-in or profiles', async ({
	page,
	browser,
	family,
}) => {
	await setUpAndSignIn(page);
	const elif = await createMember(page, {
		name: 'Elif',
		role: 'supervised',
		about: '9 years old',
		pin: '2468',
	});

	// Pair a display that may only view the calendar (what the pairing screen does).
	const { context: wall, display } = await pairDisplay(page, browser, family, {
		capabilities: ['calendar.view'],
		name: 'Hallway',
	});
	const origin = family.url;
	const headers = { origin };
	const status = async (method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown) =>
		(
			await wall.request.fetch(`${origin}${path}`, {
				method,
				headers,
				...(data !== undefined && { data }),
			})
		).status();

	// Control: what it was granted works.
	const today = day(0);
	expect(await status('GET', `/api/v1/calendar/occurrences?from=${today}&to=${today}`)).toBe(200);

	// Writes are refused, for every kind of action.
	for (const [action, input] of [
		['calendar.createEvent', { title: 'Sneaky', allDay: true, date: today }],
		['lists.addShoppingItems', { items: [{ title: 'Sneaky' }] }],
		['core.createMember', { displayName: 'Intruder', roleId: 'admin' }],
		['core.setMyNextUp', { mode: 'me' }],
	] as const) {
		expect([401, 403], action).toContain(await status('POST', `/api/v1/actions/${action}`, input));
	}

	// Reads outside the granted capabilities are refused, and so is the per-member chores read.
	for (const path of [
		'/api/v1/records/upcoming',
		'/api/v1/lists/shopping/lists',
		'/api/v1/core/members',
		'/api/v1/chores/today',
		'/api/v1/ambient/weather',
		'/api/v1/ambient/photos/today',
	])
		expect([401, 403], path).toContain(await status('GET', path));

	// No profiles, no PIN sign-in, no way to make itself a family device.
	expect(await status('GET', '/api/v1/core/profiles')).toBe(401);
	expect(await status('GET', '/api/v1/core/me')).toBe(401);
	const pin = await status('POST', '/api/auth/sign-in/pin', { memberId: elif, pin: '2468' });
	expect(pin).toBeGreaterThanOrEqual(400);
	expect(await status('GET', '/api/v1/core/me')).toBe(401);
	expect([401, 403]).toContain(
		await status('POST', '/api/v1/core/devices/trust', { name: 'Hack' }),
	);

	// Nothing was created by any of it.
	const events = await api<unknown>(
		page,
		'GET',
		`/api/v1/calendar/occurrences?from=${today}&to=${today}`,
	);
	expect(JSON.stringify(events)).not.toContain('Sneaky');
	const lists = await api<{ id: string }[]>(page, 'GET', '/api/v1/lists/shopping/lists');
	const items = await api<{ title: string }[]>(
		page,
		'GET',
		`/api/v1/lists/shopping/lists/${lists[0]?.id}/items`,
	);
	expect(items).toEqual([]);

	// The page itself offers no way in: nothing to press, no link, no keypad; and while it opens
	// it reads only what it may and never runs an action.
	const asked: string[] = [];
	display.on('request', (r) => {
		const url = new URL(r.url());
		if (url.pathname.startsWith('/api/')) asked.push(`${r.method()} ${url.pathname}`);
	});
	const refused: string[] = [];
	display.on('response', (r) => {
		if ([401, 403].includes(r.status())) refused.push(new URL(r.url()).pathname);
	});
	await display.goto('/display');
	await expect(display.getByTestId('today-body')).toHaveAttribute('data-settled', 'true');
	await expect(display.getByRole('button')).toHaveCount(0);
	await expect(display.getByRole('link')).toHaveCount(0);
	await expect(display.getByRole('radio')).toHaveCount(0);
	await expect(display.getByRole('textbox')).toHaveCount(0);
	expect(asked.filter((r) => !r.startsWith('GET '))).toEqual([]);
	expect(asked.filter((r) => r.includes('/actions/') || r.includes('/auth/'))).toEqual([]);
	expect(refused).toEqual([]);

	// The login page on the display offers neither profiles nor a keypad.
	const login = await wall.newPage();
	await login.goto('/login');
	await expect(login.getByRole('heading', { name: "Who's using FamilyOS?" })).toHaveCount(0);
	await expect(login.getByRole('button', { name: 'Elif' })).toHaveCount(0);
	await expect(login.getByRole('button', { name: '2', exact: true })).toHaveCount(0);
	await wall.close();
});
