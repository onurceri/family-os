import {
	ADMIN,
	addCard,
	api,
	draftCard,
	expect,
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
	await expect(page.getByLabel('Setup code')).toHaveValue(SETUP_CODE);
	await page.getByLabel('Your name').fill(ADMIN.name);
	await page.getByLabel('Email').fill(ADMIN.email);
	await page.getByLabel('Password').fill(ADMIN.password);
	await page.getByRole('button', { name: 'Create account' }).click();
	// Photos & weather, installed for a new family, offers its place next; it can wait.
	await page.getByRole('button', { name: 'Skip' }).click();
	await expect(page.getByTestId('day-sentence').filter({ hasText: ADMIN.name })).toBeVisible();

	// Share a school notice; the (fake) model proposes an event.
	const date = nextWeek();
	model.answer({
		summary: 'Zoo trip next week',
		proposals: [
			{
				action: 'calendar.createEvent',
				input: { title: 'Zoo trip', allDay: true, date },
				dateText: date,
				confidence: 0.9,
				uncertainFields: [],
			},
		],
	});
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
