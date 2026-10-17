import { answer, mention, on } from '../support/drafts.ts';
import {
	addCard,
	api,
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
	await api(page, 'PUT', '/api/v1/ai/roles', none);

	const date = nextWeek();
	model.answer(
		answer('A zoo trip', mention('calendar.event', { title: 'Zoo trip', date: on(date) })),
	);
	await shareText(page, `The zoo trip is on ${date}`);

	// It does not hang on "Reading…": the item says what is wrong and offers to try again.
	await expect(page.getByRole('alert').getByText('AI is not set up yet.')).toBeVisible();
	await expect(
		page.getByRole('link', { name: 'Choose a model in Settings → AI, then try again.' }),
	).toBeVisible();
	await expect(page.getByText('Reading…')).toHaveCount(0);
	expect(model.prompts).toHaveLength(0);

	// The admin sets the models up again; "Try again" reads the same item and drafts appear.
	await api(page, 'PUT', '/api/v1/ai/roles', settings.roles);
	await page.getByRole('button', { name: 'Try again' }).click();
	const card = draftCard(page, 'Zoo trip');
	await expect(card).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(0);
	await addCard(card);
	expect((await occurrences(page, date, date)).map((o) => o.title)).toEqual(['Zoo trip']);
});
