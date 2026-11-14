import {
	api,
	expect,
	FAMILY_TIME_ZONE,
	nextWeek,
	setUpAndSignIn,
	test,
} from '../support/fixtures.ts';

type Occurrence = {
	eventId: string;
	title: string;
	start: number | null;
	startDate: string | null;
	location: string | null;
};
type Detail = { id: string; title: string; reminder: number | null; recurrence: unknown };

const occurrences = (page: Parameters<typeof api>[0], from: string, to: string) =>
	api<Occurrence[]>(page, 'GET', `/api/v1/calendar/occurrences?from=${from}&to=${to}`);

/** The clock time of an instant in the family's time zone, as HH:MM. */
const clockOf = (ms: number) =>
	new Intl.DateTimeFormat('en-GB', {
		timeZone: FAMILY_TIME_ZONE,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(ms);

/** Opens the "Add event" form on `date` (the form starts on the selected day). */
async function startNewEvent(page: Parameters<typeof api>[0], title: string, date: string) {
	await page.getByRole('button', { name: 'Add event' }).click();
	await page.getByLabel('Title').fill(title);
	await page.getByLabel('Date').fill(date);
}

test('create a timed event, edit it, and give it a reminder', async ({ page }) => {
	await setUpAndSignIn(page);
	const date = nextWeek();
	await page.goto('/calendar');

	await startNewEvent(page, 'Piano lesson', date);
	await page.getByLabel('Starts').fill('16:00');
	await page.getByLabel('Ends').fill('17:00');
	await page.getByLabel('Where').fill('Music school');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved')).toBeVisible();

	// The week of the new event is shown, with the event in the family's time zone.
	const [created] = await occurrences(page, date, date);
	expect(created?.title).toBe('Piano lesson');
	expect(clockOf(created?.start as number)).toBe('16:00');
	expect(created?.location).toBe('Music school');
	const row = page.getByRole('button', { name: /Piano lesson/ });
	await expect(row).toContainText('Music school');
	await expect(row).toContainText(/4:00|16:00/);

	// A timed event has the default reminder (30 minutes); the form shows it.
	const eventId = created?.eventId as string;
	expect((await api<Detail>(page, 'GET', `/api/v1/calendar/events/${eventId}`)).reminder).toBe(30);

	// Edit: another title, another time, a different place, and a reminder an hour before.
	await row.click();
	await expect(page.getByLabel('Reminder')).toHaveValue('30');
	await page.getByLabel('Title').fill('Piano lesson (grade 3)');
	await page.getByLabel('Starts').fill('17:30');
	await page.getByLabel('Ends').fill('18:30');
	await page.getByLabel('Where').fill('Room 4');
	await page.getByLabel('Reminder').selectOption({ label: '1 hour before' });
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved')).toBeVisible();

	const edited = await occurrences(page, date, date);
	expect(edited).toHaveLength(1);
	expect(edited[0]?.title).toBe('Piano lesson (grade 3)');
	expect(edited[0]?.eventId).toBe(eventId);
	expect(clockOf(edited[0]?.start as number)).toBe('17:30');
	expect(edited[0]?.location).toBe('Room 4');
	const row2 = page.getByRole('button', { name: /Piano lesson \(grade 3\)/ });
	await expect(row2).toContainText('Room 4');

	// The reminder is stored, and the form shows it again after a reload.
	expect((await api<Detail>(page, 'GET', `/api/v1/calendar/events/${eventId}`)).reminder).toBe(60);
	await page.reload();
	await page.getByRole('button', { name: 'Next week' }).click();
	await page.getByRole('button', { name: /Piano lesson \(grade 3\)/ }).click();
	await expect(page.getByLabel('Reminder')).toHaveValue('60');
	await expect(page.getByLabel('Reminder').locator('option:checked')).toHaveText('1 hour before');

	// No reminder at all can be chosen too.
	await page.getByLabel('Reminder').selectOption('none');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByText('Saved')).toBeVisible();
	expect(
		(await api<Detail>(page, 'GET', `/api/v1/calendar/events/${eventId}`)).reminder,
	).toBeNull();
});
