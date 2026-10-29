import { answer, mention, on } from '../support/drafts.ts';
import {
	ADMIN,
	addCard,
	api,
	draftCard,
	expect,
	FAMILY_TIME_ZONE,
	nextWeek,
	shareText,
	test,
} from '../support/fixtures.ts';
import { SETUP_CODE } from '../support/server.ts';

// This spec sets the family up itself.
test.use({ freshFamily: true });

test('setup, share, approve, undo, and a session that survives a restart', async ({
	page,
	family,
	model,
}) => {
	// Without a session no page but setup renders, so nothing asks the API as a signed-in person.
	const refused: string[] = [];
	page.on('response', (r) => {
		if (r.status() === 401) refused.push(r.url());
	});
	// A fresh instance asks for the one-time code; the address from the log carries it.
	await page.goto('/');
	await expect(page).toHaveURL(/\/setup$/);
	await page.goto(`/setup?code=${SETUP_CODE}`);
	// The first screen is the language; the browser's English is preselected.
	await expect(page.getByRole('radio', { name: /English/ })).toHaveAttribute(
		'aria-checked',
		'true',
	);
	await page.getByRole('button', { name: 'Continue' }).click();
	// The code from the link shows as one line; "Change code" opens the field with it filled in.
	await expect(page.getByText('The setup code came with the link.')).toBeVisible();
	await page.getByRole('button', { name: 'Change code' }).click();
	await expect(page.getByLabel('Setup code')).toHaveValue(SETUP_CODE);
	// The time zone and region format are this browser's guess, shown to check and correct.
	const guessed = page.getByTestId('setup-region-summary');
	await expect(guessed).toContainText(FAMILY_TIME_ZONE.replaceAll('_', ' '));
	await expect(guessed).toContainText('(en-US)');
	await page.getByRole('button', { name: 'Change', exact: true }).click();
	await expect(page.getByLabel('Time zone')).toHaveValue(FAMILY_TIME_ZONE);
	await expect(page.getByLabel('Region format')).toHaveValue('en-US');
	await page.getByLabel('Region format').fill('en-GB');
	await page.getByLabel('Your name').fill(ADMIN.name);
	await page.getByLabel('Email').fill(ADMIN.email);
	await page.getByLabel('Password').fill(ADMIN.password);
	// The region brought its own clock.
	await expect(page.getByRole('radio', { name: /^14:30$/ })).toHaveAttribute(
		'aria-checked',
		'true',
	);
	await page.getByRole('button', { name: 'Create account' }).click();
	// Photos & weather, installed for a new family, offers its place next; it can wait.
	await page.getByRole('button', { name: 'Skip' }).click();
	await expect(page.getByTestId('day-sentence').filter({ hasText: ADMIN.name })).toBeVisible();
	expect(refused).toEqual([]);
	expect(
		await api<{ timeZone: string; formatLocale: string; hourCycle: string }>(
			page,
			'GET',
			'/api/v1/core/settings/family',
		),
	).toMatchObject({ timeZone: FAMILY_TIME_ZONE, formatLocale: 'en-GB', hourCycle: 'h23' });

	// Share a school notice; the (fake) model proposes an event.
	const date = nextWeek();
	model.answer(
		answer('Zoo trip next week', mention('calendar.event', { title: 'Zoo trip', date: on(date) })),
	);
	await shareText(page, `Class 4-B goes to the zoo on ${date}.`);
	const card = draftCard(page, 'Zoo trip');
	await expect(card).toBeVisible();
	await addCard(card);
	expect(
		await api<unknown[]>(page, 'GET', `/api/v1/calendar/occurrences?from=${date}&to=${date}`),
	).toHaveLength(1);

	// Undo in the notice takes it back.
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByRole('status').getByText('Taken back')).toBeVisible();
	expect(
		await api<unknown[]>(page, 'GET', `/api/v1/calendar/occurrences?from=${date}&to=${date}`),
	).toHaveLength(0);

	// An update or reboot keeps people signed in.
	await family.restart();
	await page.goto('/');
	await expect(page.getByTestId('day-sentence').filter({ hasText: ADMIN.name })).toBeVisible();
});
