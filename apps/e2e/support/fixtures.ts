import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeBotApi, startFakeBotApi } from '@famos/adapters/telegram/fake-bot-api';
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { type FakeModel, startFakeModel } from './fake-model.ts';
import { type FamilyOS, startFamilyOS } from './server.ts';
import { api, FAMILY_TIME_ZONE, setUpThroughTheUi } from './sign-in.ts';
import { copyTemplate, templateFromEnv } from './template.ts';

export { ADMIN, api, FAMILY_TIME_ZONE, signInWithPassword } from './sign-in.ts';

const template = templateFromEnv();

/** The addresses of the running families that started from the prepared one (signed in already). */
const prepared = new Set<string>();

/**
 * Every test gets its own FamilyOS and its own fake model. By default the family is a copy of
 * the one global setup prepared (support/template.ts) and the browser starts signed in as the
 * admin; `test.use({ freshFamily: true })` gives an empty data directory and a browser without
 * cookies instead, for the tests of setup and sign-in themselves.
 */
export const test = base.extend<{
	/** An empty data directory and no session, instead of the prepared family. */
	freshFamily: boolean;
	/** The server believes `X-Forwarded-For` from the test, which can then speak from other addresses. */
	behindProxy: boolean;
	model: FakeModel;
	botApi: FakeBotApi;
	/** A directory standing in for the IMAP server (`FAMOS_EMAIL_FAKE_DIR`, testing only). */
	mailbox: { dir: string; inbox: string };
	family: FamilyOS;
}>({
	freshFamily: [false, { option: true }],
	behindProxy: [false, { option: true }],
	// biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
	model: async ({}, use) => {
		const model = await startFakeModel();
		await use(model);
		await model.close();
	},
	// The server talks to this stand-in Telegram Bot API; it only does something once an admin
	// pastes `botApi.token` in Settings → Telegram.
	// biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
	botApi: async ({}, use) => {
		const botApi = await startFakeBotApi();
		await use(botApi);
		await botApi.close();
	},
	// Mail the server "polls": .eml files in `<dir>/INBOX`.
	// biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
	mailbox: async ({}, use) => {
		const dir = await mkdtemp(join(tmpdir(), 'famos-e2e-mail-'));
		const inbox = join(dir, 'INBOX');
		await mkdir(inbox);
		await use({ dir, inbox });
		await rm(dir, { recursive: true, force: true });
	},
	family: async ({ model, botApi, mailbox, freshFamily, behindProxy }, use) => {
		const from = freshFamily ? undefined : template;
		const dataDir = from && (await copyTemplate(from));
		const family = await startFamilyOS({
			modelUrl: model.baseUrl,
			telegramApiRoot: botApi.url,
			emailFakeDir: mailbox.dir,
			...(dataDir && { dataDir }),
			behindProxy,
		});
		if (from) prepared.add(family.url);
		await use(family);
		prepared.delete(family.url);
		await family.close();
	},
	baseURL: async ({ family }, use) => use(family.url),
	// The prepared family's session, in the test's own browser only: `storageState` would reach
	// every `browser.newContext()` a test opens as well. Cookies on localhost hold for every port.
	context: async ({ context, freshFamily }, use) => {
		if (template && !freshFamily) await context.addCookies(template.cookies);
		await use(context);
	},
	locale: 'en-US',
	timezoneId: FAMILY_TIME_ZONE,
});
export { expect };

/**
 * Opens Today signed in as the admin Deniz of a family that is set up. A prepared family (the
 * default) is that already; a fresh one is set up through the API and signed in through the UI.
 */
export async function setUpAndSignIn(page: Page) {
	await page.goto('/');
	if (prepared.has(new URL(page.url()).origin))
		await expect(page.getByTestId('day-sentence')).toBeVisible();
	else await setUpThroughTheUi(page);
}

/** Types text into the Quick add box and presses Send (the same path as the share target, minus the OS). */
export async function shareText(page: Page, text: string) {
	await page.goto('/add');
	await page.getByLabel('Something to add').fill(text);
	await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/**
 * Presses "Add selected" ("Apply selected" when not everything adds) in the capture group that
 * holds `card` (everything in it is ticked unless a test unticked it) and waits for the notice.
 */
export async function addCard(card: Locator) {
	const page = card.page();
	await page
		.getByTestId('capture-group')
		.filter({ has: card })
		.getByRole('button', { name: /^(Add|Apply) selected/ })
		.click();
	await expect(page.getByRole('status').filter({ hasText: /^\d+ (added|done)/ })).toBeVisible();
}

/** Presses the only "Add selected" (or "Apply selected") on the page and waits for the notice. */
export async function addAll(page: Page) {
	await page.getByRole('button', { name: /^(Add|Apply) selected/ }).click();
	await expect(page.getByRole('status').filter({ hasText: /^\d+ (added|done)/ })).toBeVisible();
}

/**
 * Waits until the model has finished reading every capture. Quick add keeps a capture it saw
 * being read under "Waiting for you" (by design), so open the page after this, not before, when
 * the test then looks for the capture under Recent.
 */
export async function capturesRead(page: Page) {
	await expect
		.poll(async () => {
			const items = await api<{ status: string }[]>(page, 'GET', '/api/v1/inbox/items');
			return items.length > 0 && items.every((i) => !['received', 'normalized'].includes(i.status));
		})
		.toBe(true);
}

/**
 * Opens an earlier capture from Recent and returns its detail in the side panel. Without
 * `hasText` it is the first one.
 */
export async function openRecent(page: Page, hasText?: string | RegExp) {
	const rows = page.getByTestId('recent-row');
	await (hasText ? rows.filter({ hasText }) : rows).first().click();
	const detail = page.getByTestId('capture-detail');
	await expect(detail).toBeVisible();
	return detail;
}

/** A date (YYYY-MM-DD) a week from today in the family's time zone, so it never flakes near midnight. */
export function nextWeek(): string {
	// en-CA formats as YYYY-MM-DD. Adding seven days of milliseconds can be off by an hour across
	// a DST change, which cannot move the date by itself at midday.
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: FAMILY_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date(Date.now() + 7 * 86_400_000));
}

/** The draft card proposing `title` (draft cards sit inside their capture's group). */
export function draftCard(page: Page, title: string) {
	return page
		.getByRole('article')
		.filter({ has: page.getByRole('heading', { name: title, exact: true }) })
		.filter({ hasNot: page.getByRole('article') });
}
