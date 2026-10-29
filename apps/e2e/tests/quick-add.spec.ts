import { answer, mention, on } from '../support/drafts.ts';
import {
	addCard,
	api,
	capturesRead,
	draftCard,
	expect,
	nextWeek,
	setUpAndSignIn,
	shareText,
	test,
} from '../support/fixtures.ts';

type Occurrence = { title: string; startDate: string | null; start: number | null };
const occurrences = (page: Parameters<typeof api>[0], from: string, to: string) =>
	api<Occurrence[]>(page, 'GET', `/api/v1/calendar/occurrences?from=${from}&to=${to}`);

test('a model that cannot answer leaves a failed item with an explanation and a working retry', async ({
	page,
	model,
}) => {
	await setUpAndSignIn(page);
	// Take the models away: Quick add has nothing to read with (a failure only a person can fix).
	const settings = await api<{ roles: Record<string, unknown> }>(
		page,
		'GET',
		'/api/v1/ai/settings',
	);
	const none = Object.fromEntries(Object.keys(settings.roles).map((role) => [role, null]));
	await api(page, 'POST', '/api/v1/actions/core.setAiRoles', none);

	const date = nextWeek();
	model.answer(
		answer('A zoo trip', mention('calendar.event', { title: 'Zoo trip', date: on(date) })),
	);
	await shareText(page, `The zoo trip is on ${date}`);

	// It does not hang on "Reading…": the item says what is wrong and offers to try again.
	await expect(page.getByRole('alert').getByText('AI is not set up yet.')).toBeVisible();
	await expect(
		page.getByTestId('capture-group').getByRole('link', { name: 'Set up AI' }),
	).toBeVisible();
	await expect(page.getByText('Reading…')).toHaveCount(0);
	expect(model.prompts).toHaveLength(0);

	// The admin sets the models up again; "Try again" reads the same item and drafts appear.
	await api(page, 'POST', '/api/v1/actions/core.setAiRoles', settings.roles);
	await page.getByRole('button', { name: 'Try again' }).click();
	const card = draftCard(page, 'Zoo trip');
	await expect(card).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await addCard(card);
	expect((await occurrences(page, date, date)).map((o) => o.title)).toEqual(['Zoo trip']);
});

test('"Dismiss the rest" dismisses what is not ticked, says so, and leaves the ticked one to add', async ({
	page,
	model,
}) => {
	await setUpAndSignIn(page);
	const date = nextWeek();
	model.answer(
		answer(
			'Recital',
			mention('calendar.event', { title: 'Piano recital', date: on(date) }),
			mention('lists.task', { title: 'Buy flowers' }),
		),
	);
	await shareText(page, `Piano recital on ${date}, buy flowers`);
	await capturesRead(page);
	await page.goto('/add');
	const group = page.getByTestId('capture-group').first();
	await group.getByRole('checkbox').nth(1).uncheck();
	await group.getByRole('button', { name: /^Dismiss the rest/ }).click();
	await group.getByRole('button', { name: 'Tap again to dismiss' }).click();
	await expect(page.getByRole('status').filter({ hasText: '1 dismissed' })).toBeVisible();
	await expect(group.getByText('Withdrawn')).toBeVisible();
	await expect(group.getByRole('button', { name: /^Add selected from/ })).toBeEnabled();
});
