import { expect, type Page } from '@playwright/test';
import { SETUP_CODE } from './server.ts';

// Kept apart from fixtures.ts so global setup can use them without loading the test fixtures.

/** The family's time zone in these specs (browser contexts and first-run setup use it too). */
export const FAMILY_TIME_ZONE = 'Europe/Istanbul';

export const ADMIN = {
	name: 'Deniz',
	email: 'deniz@example.com',
	password: 'correct horse battery',
};

/** Calls the API with the page's cookies (the session), as the app itself does. */
export async function api<T = unknown>(
	page: Page,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	path: string,
	data?: unknown,
): Promise<T> {
	const origin = new URL(page.url()).origin;
	// A name only the browser can resolve (`insecureHost`): ask through the page itself.
	if (new URL(origin).hostname !== 'localhost') {
		const result = await page.evaluate(
			async ({ method, path, data }) => {
				const res = await fetch(path, {
					method,
					...(data !== undefined && {
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(data),
					}),
				});
				return { ok: res.ok, status: res.status, text: await res.text() };
			},
			{ method, path, data },
		);
		if (!result.ok) throw new Error(`${method} ${path} → ${result.status} ${result.text}`);
		return (result.text ? JSON.parse(result.text) : null) as T;
	}
	const res = await page.request.fetch(`${origin}${path}`, {
		method,
		headers: { origin },
		...(data !== undefined && { data }),
	});
	if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
	const text = await res.text();
	return (text ? JSON.parse(text) : null) as T;
}

/** First-run setup through the API (the page is open on the family's address), then sign-in through the UI. */
export async function setUpThroughTheUi(page: Page) {
	await api(page, 'POST', '/api/v1/core/setup', {
		displayName: ADMIN.name,
		email: ADMIN.email,
		password: ADMIN.password,
		locale: 'en',
		timeZone: FAMILY_TIME_ZONE,
		setupCode: SETUP_CODE,
	});
	await signInWithPassword(page, ADMIN.email, ADMIN.password);
}

export async function signInWithPassword(page: Page, email: string, password: string) {
	await page.goto('/login');
	// Without PIN profiles on this device the page opens the email form by itself, possibly
	// just after the profile picker rendered; accept either order.
	const emailField = page.getByLabel('Email', { exact: true });
	await expect(async () => {
		if (!(await emailField.isVisible()))
			await page.getByRole('button', { name: 'Sign in with email' }).click({ timeout: 1000 });
		await expect(emailField).toBeVisible({ timeout: 1000 });
	}).toPass();
	await emailField.fill(email);
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page.getByTestId('day-sentence')).toBeVisible();
}
