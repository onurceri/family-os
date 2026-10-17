import { answer, mention, on } from '../support/drafts.ts';
import {
	addCard,
	draftCard,
	expect,
	nextWeek,
	setUpAndSignIn,
	shareText,
	test,
} from '../support/fixtures.ts';
import { createMember, familyTablet, PHONE } from '../support/members.ts';

/** Sign-in on a phone with a password, and with a PIN only on a trusted family device. */

test('on a browser that is not a family device there are no profiles and a PIN never signs in', async ({
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

	const context = await browser.newContext({ ...PHONE, baseURL: family.url });
	const stranger = await context.newPage();
	await stranger.goto('/login');
	await expect(stranger.getByLabel('Email', { exact: true })).toBeVisible();
	await expect(stranger.getByRole('heading', { name: "Who's using FamilyOS?" })).toHaveCount(0);
	await expect(stranger.getByRole('button', { name: 'Elif' })).toHaveCount(0);
	await expect(stranger.getByText('Elif')).toHaveCount(0);

	const origin = family.url;
	expect((await stranger.request.get(`${origin}/api/v1/core/profiles`)).status()).toBe(401);
	// The right PIN for a real member is still refused: a short PIN only works at home.
	const attempt = await stranger.request.post(`${origin}/api/auth/sign-in/pin`, {
		headers: { origin },
		data: { memberId: elif, pin: '2468' },
	});
	expect(attempt.status()).toBeGreaterThanOrEqual(400);
	expect((await stranger.request.get(`${origin}/api/v1/core/me`)).status()).toBe(401);
	await context.close();
});

test('a wrong PIN is refused; a PIN session is a member session without admin settings', async ({
	page,
	browser,
	family,
}) => {
	await setUpAndSignIn(page);
	await createMember(page, { name: 'Elif', role: 'supervised', about: '9 years old', pin: '2468' });
	const { context, page: tablet } = await familyTablet(browser, family);

	await tablet.goto('/login');
	await tablet.getByRole('button', { name: 'Elif' }).click();
	for (const digit of '1357')
		await tablet.getByRole('button', { name: digit, exact: true }).click();
	await tablet.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(tablet.getByText('Wrong PIN.')).toBeVisible();
	await expect(tablet.getByTestId('day-sentence')).toHaveCount(0);
	expect((await tablet.request.get(`${family.url}/api/v1/core/me`)).status()).toBe(401);

	for (const digit of '2468')
		await tablet.getByRole('button', { name: digit, exact: true }).click();
	await tablet.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(tablet.getByTestId('day-sentence').filter({ hasText: 'Elif' })).toBeVisible();

	// No admin entries, the admin pages say they are not for her, the admin API refuses.
	await tablet.goto('/more');
	await expect(tablet.getByRole('heading', { name: 'More' })).toBeVisible();
	for (const name of ['Members', 'Roles', 'Devices', 'Backups', 'Provider & models'])
		await expect(tablet.getByRole('link', { name, exact: true }), name).toHaveCount(0);
	for (const path of ['/settings/devices', '/settings/members']) {
		await tablet.goto(path);
		await expect(
			tablet.getByRole('heading', { name: /^This page is for people who may use / }),
		).toBeVisible();
	}
	const origin = family.url;
	const post = async (path: string, data: unknown) =>
		(
			await tablet.request.fetch(`${origin}${path}`, { method: 'POST', headers: { origin }, data })
		).status();
	expect(
		await post('/api/v1/actions/core.createMember', { displayName: 'Intruder', roleId: 'admin' }),
	).toBe(403);
	expect(await post('/api/v1/core/devices/trust', { name: 'Hack' })).toBeGreaterThanOrEqual(400);
	await context.close();
});

const zooTrip = (date: string) =>
	answer('Zoo trip', mention('calendar.event', { title: 'Zoo trip', date: on(date) }));

test('a supervised member signs in with a PIN on a family device; changes wait for approval', async ({
	page,
	browser,
	family,
	model,
}) => {
	await setUpAndSignIn(page);
	await createMember(page, {
		name: 'Elif',
		role: 'supervised',
		about: '9 years old, class 4-B',
		pin: '2468',
	});

	// The kitchen tablet: an admin marks it as a family device, then signs out.
	const { context, page: tablet } = await familyTablet(browser, family);

	// The profile picker shows only PIN profiles; the keypad signs Elif in.
	await tablet.goto('/login');
	await expect(tablet.getByRole('heading', { name: "Who's using FamilyOS?" })).toBeVisible();
	await expect(tablet.getByRole('button', { name: /Deniz/ })).toHaveCount(0);
	await tablet.getByRole('button', { name: 'Elif' }).click();
	for (const digit of '2468')
		await tablet.getByRole('button', { name: digit, exact: true }).click();
	await tablet.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(tablet.getByTestId('day-sentence').filter({ hasText: 'Elif' })).toBeVisible();

	// Her share becomes a proposal she cannot approve herself.
	model.answer(zooTrip(nextWeek()));
	await shareText(tablet, 'Our class goes to the zoo next week');
	await expect(draftCard(tablet, 'Zoo trip').getByText('Waiting for approval')).toBeVisible();

	// An admin approves it on their own phone.
	await page.goto('/add');
	const card = draftCard(page, 'Zoo trip');
	await addCard(card);
	// Decided: the capture is Elif's, so it leaves the admin's Quick add.
	await expect(card).toHaveCount(0);
	await context.close();
});
