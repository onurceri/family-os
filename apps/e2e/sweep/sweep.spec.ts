import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { api, setUpAndSignIn, test } from '../support/fixtures.ts';
import { seedSampleFamily } from '../support/sample-data.ts';
import { standAt } from '../support/today.ts';

/**
 * A screenshot sweep for design review, not a test and not part of `pnpm e2e`: every page, empty
 * and with data, day and night, on a desktop, a small laptop (1024 px) and a phone, in each style
 * Run with `pnpm sweep` (sweep.config.ts); pictures land in
 * test-results/sweep/pages/<state>/<page>/<style>-<scheme>-<size>.png.
 *
 * - `FAMOS_SWEEP_STYLES=wall,lanes` limits the styles (all three by default);
 * - `FAMOS_SWEEP_STATE=empty` or `data` limits the state;
 * - `FAMOS_SWEEP_ONLY=more,s-ai` limits the pages;
 * - `FAMOS_SWEEP_OUT` replaces test-results/sweep.
 *
 * With data, the browser stands at 15:20, before the day's later events.
 */

type Entry = {
	name: string;
	path: string;
	/** Only these sizes (the phone-only More pages redirect on a wide window). */
	only?: 'phone';
	/** Something to press before the picture (a calendar view). */
	prep?: (page: Page) => Promise<void>;
	/** With data, the time of day to stand at instead of 15:20 (HH:MM). */
	at?: string;
};

const pressIfThere = (name: string) => async (page: Page) => {
	const button = page.getByRole('button', { name, exact: true }).first();
	if (await button.isVisible().catch(() => false)) {
		await button.click();
		await page.waitForTimeout(300);
	}
};

/** Every route of the app (see apps/web/src/routes and each extension's web entry). */
const PAGES: Entry[] = [
	{ name: 'today', path: '/' },
	{ name: 'quick-add', path: '/add' },
	{ name: 'board', path: '/board' },
	{ name: 'calendar-week', path: '/calendar' },
	{ name: 'calendar-day', path: '/calendar', prep: pressIfThere('Day') },
	{ name: 'calendar-month', path: '/calendar', prep: pressIfThere('Month') },
	{ name: 'lists-tasks', path: '/lists/tasks' },
	{ name: 'lists-shopping', path: '/lists/shopping' },
	// `?ask` starts a new conversation even when one was opened before (`assistant-open`).
	{ name: 'assistant', path: '/assistant?ask' },
	{ name: 'chores', path: '/chores' },
	{ name: 'vehicles', path: '/vehicles' },
	{ name: 'home', path: '/home' },
	{ name: 'pets', path: '/pets' },
	{ name: 'kitchen', path: '/kitchen' },
	{ name: 'kitchen-plan', path: '/kitchen/plan' },
	{ name: 'notifications', path: '/notifications' },
	{ name: 'more', path: '/more', only: 'phone' },
	{ name: 'more-you', path: '/more/you', only: 'phone' },
	{ name: 'more-family', path: '/more/family', only: 'phone' },
	{ name: 'more-ai', path: '/more/ai', only: 'phone' },
	{ name: 'more-system', path: '/more/system', only: 'phone' },
	{ name: 's-profile', path: '/settings/profile' },
	{ name: 's-appearance', path: '/settings/appearance' },
	{ name: 's-notifications', path: '/settings/notifications' },
	{ name: 's-memory', path: '/settings/memory' },
	{ name: 's-calendar-feed', path: '/settings/calendar-feed' },
	{ name: 's-connected-apps', path: '/settings/connected-apps' },
	{ name: 's-members', path: '/settings/members' },
	{ name: 's-roles', path: '/settings/roles' },
	{ name: 's-devices', path: '/settings/devices' },
	{ name: 's-extensions', path: '/settings/extensions' },
	{ name: 's-region', path: '/settings/region' },
	{ name: 's-theme', path: '/settings/theme' },
	{ name: 's-calendars', path: '/settings/calendars' },
	{ name: 's-ai', path: '/settings/ai' },
	{ name: 's-ai-privacy', path: '/settings/ai/privacy' },
	{ name: 's-ai-usage', path: '/settings/ai/usage' },
	{ name: 's-ai-activity', path: '/settings/ai/activity' },
	{ name: 's-auto-approval', path: '/settings/auto-approval' },
	{ name: 's-backups', path: '/settings/backups' },
	{ name: 's-email', path: '/settings/email' },
	{ name: 's-telegram', path: '/settings/telegram' },
];

const SIZES = [
	{ name: '1440', width: 1440, height: 900 },
	{ name: '1024', width: 1024, height: 768 },
	{ name: '400', width: 400, height: 860 },
] as const;

const list = (value: string | undefined) => value?.split(',').map((s) => s.trim());
const ONLY = list(process.env.FAMOS_SWEEP_ONLY);
const STYLES = list(process.env.FAMOS_SWEEP_STYLES) ?? ['broadsheet', 'lanes', 'wall'];
const STATE = process.env.FAMOS_SWEEP_STATE;
const OUT = process.env.FAMOS_SWEEP_OUT ?? 'test-results/sweep';
/** With data, the browser stands at this time of day, before the day's later events. */
const DATA_TIME = '15:20';
/**
 * A whole-page picture would draw the phone's tab bar, and a field docked above it (Shopping's
 * add field), over the middle of the page: they go to the end of the page instead.
 */
const SHOT_STYLE =
	'nav.fixed.bottom-0, [data-dock] { position: static !important; } @media (width < 48rem) { [data-dock] { order: 99; } }';

/** Sets the style for the family and waits until the page has it. */
async function chooseStyle(page: Page, style: string) {
	await api(page, 'POST', '/api/v1/actions/core.setFamilyStyle', { style });
	await page.reload();
	await page.waitForFunction((s) => document.documentElement.dataset.style === s, style);
}

async function sweep(
	page: Page,
	style: string,
	state: string,
	extra: Entry[] = [],
	only: readonly string[] | undefined = ONLY,
) {
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		for (const size of SIZES) {
			await page.setViewportSize({ width: size.width, height: size.height });
			for (const { name, path, only: sizeOnly, prep, at } of [...PAGES, ...extra]) {
				if (only && !only.includes(name)) continue;
				if (sizeOnly === 'phone' && size.name !== '400') continue;
				if (state === 'data') await standAt(page, at ?? DATA_TIME);
				await page.goto(path);
				await page.waitForLoadState('networkidle');
				await page.waitForTimeout(250);
				await prep?.(page);
				const dir = `${OUT}/pages/${state}/${name}`;
				await mkdir(dir, { recursive: true });
				await page.screenshot({
					path: `${dir}/${style}-${scheme}-${size.name}.png`,
					fullPage: true,
					style: SHOT_STYLE,
				});
			}
		}
	}
}

/**
 * What Today shows (`today-blocks`, with data): Today in each style with everything shown, with
 * a few blocks hidden and with everything hidden; the ⋯ menu on a section label; the list in
 * Settings → Appearance. Light and dark, 1440 and 400. Only with `FAMOS_SWEEP_ONLY=today-blocks`
 * or no `FAMOS_SWEEP_ONLY` at all.
 */
const SOME_HIDDEN = ['photo', 'family', 'needs', 'nextDays', 'lists.shopping', 'board.today'];
test.describe('with a mouse', () => {
	// A desktop browser (hover, a fine pointer): the ⋯ of a section shows only on hover or focus.
	test.use({ isMobile: false, hasTouch: false });
	test('design sweep: what Today shows', async ({ page, model }) => {
		test.skip(STATE === 'empty' || (ONLY !== undefined && !ONLY.includes('today-blocks')));
		await page.setViewportSize({ width: 1440, height: 900 });
		await setUpAndSignIn(page);
		await seedSampleFamily(page, model);
		const hide = (hidden: string[] | null) =>
			api(page, 'POST', '/api/v1/actions/core.setMyTodayBlocks', { hidden });
		const shot = async (name: string, file: string) => {
			const dir = `${OUT}/today-blocks/${name}`;
			await mkdir(dir, { recursive: true });
			await page.screenshot({ path: `${dir}/${file}.png`, fullPage: true, style: SHOT_STYLE });
		};
		const open = async (path: string) => {
			await standAt(page, DATA_TIME);
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			await page.mouse.move(1, 1);
			await page.waitForTimeout(300);
		};
		// Everything hidden: every block the settings list offers.
		await open('/settings/appearance');
		const all = await page
			.locator('#today-blocks input[role="switch"]')
			.evaluateAll((inputs) => inputs.map((i) => i.id.replace(/^my-blocks-/, '')));
		for (const style of STYLES) {
			await chooseStyle(page, style);
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme });
				for (const size of SIZES.filter((s) => s.name !== '1024')) {
					await page.setViewportSize({ width: size.width, height: size.height });
					const file = `${style}-${scheme}-${size.name}`;
					await hide(null);
					await open('/');
					await shot('all-shown', file);
					// The ⋯ of a section label, open (a menu on wide windows, a sheet on phones).
					const menu = page.getByTestId('today-block-menu').first();
					await menu.locator('button').first().click();
					await page.waitForTimeout(250);
					await page.screenshot({
						path: `${OUT}/today-blocks/menu/${file}.png`,
						style: SHOT_STYLE,
					});
					await page.keyboard.press('Escape');
					await hide(SOME_HIDDEN);
					await open('/');
					await shot('some-hidden', file);
					// A whole column's blocks hidden: the other columns take its room.
					await hide(['clock', 'greeting', 'weather', 'photo', 'family', 'chores']);
					await open('/');
					await shot('column-hidden', file);
					await hide(all);
					await open('/');
					await shot('all-hidden', file);
					if (style === STYLES[0]) {
						await hide(SOME_HIDDEN);
						await open('/settings/appearance#today-blocks');
						await shot('settings', file);
					}
				}
			}
		}
		await hide(null);
	});
});

for (const style of STYLES) {
	test(`design sweep: ${style}, empty`, async ({ page }) => {
		test.skip(STATE === 'data', 'data only');
		await page.setViewportSize({ width: 1440, height: 900 });
		await setUpAndSignIn(page);
		await chooseStyle(page, style);
		await sweep(page, style, 'empty');
	});

	test(`design sweep: ${style}, with data`, async ({ page, model }) => {
		test.skip(STATE === 'empty', 'empty only');
		await page.setViewportSize({ width: 1440, height: 900 });
		await setUpAndSignIn(page);
		const ids = await seedSampleFamily(page, model);
		await standAt(page, DATA_TIME);
		await chooseStyle(page, style);
		await sweep(page, style, 'data', [
			// The next thing more than an hour away: the hero's countdown in hours and minutes.
			{ name: 'today-morning', path: '/', at: '09:14' },
			{ name: 'home-one', path: `/home/${ids.home}` },
			{ name: 'vehicle-one', path: `/vehicles/${ids.vehicle}` },
			{ name: 'pet-one', path: `/pets/${ids.pet}` },
			{ name: 'recipe-one', path: `/kitchen/recipes/${ids.recipe}` },
			{ name: 'assistant-open', path: `/assistant?thread=${ids.thread}` },
			// Below 1280 px the conversations open in a drawer.
			{ name: 'assistant-drawer', path: '/assistant?ask', prep: pressIfThere('Conversations') },
		]);
	});
}
