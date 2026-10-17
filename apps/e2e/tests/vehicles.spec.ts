import { answer, mention, on } from '../support/drafts.ts';
import {
	addCard,
	draftCard,
	expect,
	setUpAndSignIn,
	shareText,
	test,
} from '../support/fixtures.ts';

const today = () =>
	new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

const addDays = (date: string, days: number) =>
	new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

test('a vehicle with its insurance: a shared renewal moves the due date, and papers are filed by hand', async ({
	page,
	model,
}) => {
	await setUpAndSignIn(page);
	const soon = addDays(today(), 20);
	const renewedUntil = addDays(today(), 380);

	// Add the vehicle with the insurance from the "what usually needs doing" list.
	await page.goto('/more');
	await page.getByRole('link', { name: 'Vehicles' }).click();
	await expect(page.getByRole('heading', { name: 'Vehicles', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Add vehicle' }).click();
	await page.getByLabel('Name', { exact: true }).fill('Clio');
	await page.getByLabel('Plate').fill('34 ABC 123');
	await page.getByTestId('preset-comprehensive_insurance').check();
	// The preset only suggests a yearly repeat: the person sets how often it comes back.
	await page.getByTestId('preset-comprehensive_insurance-interval').fill('2');
	await page.getByLabel('Next due date for Comprehensive insurance').fill(soon);
	await page.getByRole('button', { name: 'Save' }).click();

	// The vehicle's page: its duties come from records.
	await expect(page.getByRole('heading', { name: 'Clio', exact: true })).toBeVisible();
	const needs = page.getByRole('region', { name: 'What needs doing' });
	await expect(needs.getByText('Comprehensive insurance', { exact: true })).toBeVisible();
	await expect(needs.getByText('every 2 years')).toBeVisible();
	const vehicleUrl = page.url();
	expect(vehicleUrl).toMatch(/\/vehicles\/vehicle_/);

	// Sharing the renewal: the model sees the vehicle and its insurance by name, never by id.
	model.answer(
		answer(
			'Comprehensive insurance renewed',
			mention('records.dutyDone', {
				target: 'Comprehensive insurance',
				about: 'Clio',
				date: on(today()),
				endDate: on(renewedUntil),
			}),
		),
	);
	await shareText(page, `Your insurance for 34 ABC 123 is renewed until ${renewedUntil}.`);
	await expect.poll(() => model.prompts.length).toBe(1);
	expect(model.prompts[0]).toContain('- Clio (');
	expect(model.prompts[0]).toContain('- Comprehensive insurance (Clio) (');
	expect(model.prompts[0]).not.toMatch(/vehicle_[0-9a-f]{8}-|vehicle:1/);

	const card = draftCard(page, 'Comprehensive insurance (Clio): Mark as done');
	await addCard(card);

	await page.goto(vehicleUrl);
	const due = new Intl.DateTimeFormat('en', {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(`${renewedUntil}T00:00:00Z`));
	await expect(page.getByRole('region', { name: 'What needs doing' })).toContainText(due);

	// Filing a paper by hand: "Add to…" in Quick add, no AI involved.
	await page.goto('/add');
	await page.locator('input[type=file]').setInputFiles({
		name: 'policy.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from('%PDF-1.4 insurance policy'),
	});
	await page.getByRole('button', { name: 'Add to…' }).click();
	await page.getByRole('button', { name: 'Clio' }).click();
	await page.getByRole('button', { name: 'File it' }).click();
	await expect(page.getByText('Filed on Clio')).toBeVisible();
	expect(model.prompts).toHaveLength(1);

	await page.goto(vehicleUrl);
	const papers = page.getByRole('region', { name: 'Papers' });
	await expect(papers.getByRole('link', { name: 'Open policy.pdf' })).toBeVisible();
});
