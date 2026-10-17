import type { Page } from '@playwright/test';
import { api, expect, setUpAndSignIn, test } from '../support/fixtures.ts';

/**
 * Settings → Appearance: the style first, as three live pictures of
 * Today, then the colors. A style is chosen for oneself, tried on the whole app until it is used or
 * stopped (the preview bar), defaulted by the family and chosen per display under Family → Family look.
 */
const DESKTOP = { width: 1440, height: 900 };

const styleOnDocument = (page: Page) =>
	page.evaluate(() => document.documentElement.dataset.style ?? '');
/** The page's background: the `--wall` token of the palette on screen (day). */
const wall = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const EV_ISIGI = 'rgb(236, 235, 230)';
const FOREST = 'rgb(227, 233, 224)';

test('choosing Wall for oneself makes Today Wall, after a reload too', async ({ page }) => {
	await setUpAndSignIn(page);
	await page.setViewportSize(DESKTOP);
	await page.goto('/settings/appearance');

	// Three pictures, one per style, Broadsheet in use.
	for (const id of ['broadsheet', 'lanes', 'wall'])
		await expect(page.getByTestId(`style-preview-${id}`)).toBeVisible();
	await expect(page.getByTestId('style-broadsheet').getByTestId('style-in-use')).toBeVisible();
	// The pictures are the real compositions, with the made-up day.
	await expect(
		page.getByTestId('style-preview-wall').locator('[data-layout="wall"]'),
	).toBeAttached();
	await expect(page.getByTestId('style-preview-lanes')).toContainText('Swimming lesson');

	await page.getByTestId('use-style-wall').click();
	await expect(page.getByTestId('style-wall').getByTestId('style-in-use')).toBeVisible();
	await expect.poll(() => styleOnDocument(page)).toBe('wall');

	await page.goto('/');
	await page.reload();
	await expect(page.getByTestId('today-body')).toHaveAttribute('data-layout', 'wall');
	expect(await styleOnDocument(page)).toBe('wall');

	// Following the family again goes back to Broadsheet.
	await page.goto('/settings/appearance');
	await page.getByTestId('style-follow-family').click();
	await expect(page.getByTestId('style-broadsheet').getByTestId('style-in-use')).toBeVisible();
	await expect.poll(() => styleOnDocument(page)).toBe('broadsheet');
});

test('trying Lanes opens Today in Lanes and lasts across the app until it is decided', async ({
	page,
}) => {
	await setUpAndSignIn(page);
	await page.setViewportSize(DESKTOP);
	await page.goto('/settings/appearance');
	const bar = page.getByTestId('theme-preview-bar');
	// Nothing on the page says a preview stays on this page.
	await expect(page.getByText('Only on this screen')).toHaveCount(0);

	// A palette is tried here: the page recolours, the sample shows it, the bar names it.
	await page.getByTestId('preview-forest').click();
	await expect(bar).toContainText('Trying Forest');
	await expect.poll(() => wall(page)).toBe(FOREST);
	await expect(page.getByTestId('palette-sample')).toContainText('Forest');
	// No "Keep looking" on the page one keeps looking on.
	await expect(bar.getByRole('button', { name: 'Keep looking' })).toHaveCount(0);

	// A style is tried on Today, where it shows; the palette stays.
	await page.getByTestId('try-style-lanes').click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByTestId('today-body')).toHaveAttribute('data-layout', 'lanes');
	await expect(bar).toContainText('Trying Lanes · Forest');
	expect(await styleOnDocument(page)).toBe('lanes');
	expect(await wall(page)).toBe(FOREST);

	// Another page: the bar and the palette are still there.
	await page.locator('nav a[href="/lists/shopping"]').filter({ visible: true }).first().click();
	await expect(page).toHaveURL(/\/lists\/shopping$/);
	await expect(bar).toContainText('Trying Lanes · Forest');
	await expect.poll(() => wall(page)).toBe(FOREST);
	expect(await styleOnDocument(page)).toBe('lanes');

	// Keep looking goes back to Appearance, and Back to where it was.
	await bar.getByRole('button', { name: 'Keep looking' }).click();
	await expect(page).toHaveURL(/\/settings\/appearance$/);
	await expect(page.getByTestId('style-broadsheet').getByTestId('style-in-use')).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(/\/lists\/shopping$/);

	// Stop: the person's own style and palette return, and nothing was saved.
	await bar.getByRole('button', { name: 'Stop' }).click();
	await expect(bar).toHaveCount(0);
	await expect.poll(() => styleOnDocument(page)).toBe('broadsheet');
	await expect.poll(() => wall(page)).toBe(EV_ISIGI);
	const appearance = await api<{ style: string; myStyle: string | null; mine: string | null }>(
		page,
		'GET',
		'/api/v1/core/appearance',
	);
	expect(appearance).toMatchObject({ style: 'broadsheet', myStyle: null, mine: null });

	// A reload ends a preview: the real choice shows.
	await page.goto('/settings/appearance');
	await page.getByTestId('try-style-wall').click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByTestId('today-body')).toHaveAttribute('data-layout', 'wall');
	await page.reload();
	await expect(page.getByTestId('today-body')).toHaveAttribute('data-layout', 'broadsheet');
	await expect(bar).toHaveCount(0);
});
