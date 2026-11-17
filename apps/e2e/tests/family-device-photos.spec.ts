import { ADMIN, api, expect, setUpAndSignIn, test } from '../support/fixtures.ts';
import { signInAs } from '../support/members.ts';

/** The family's photos on a family device left alone, and the touch that brings the app back. */

// A one-pixel PNG: enough for the photo library.
const PIXEL = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64',
);

test('a family device shows the photos after a while; a tap brings the page back as it was', async ({
	page,
	browser,
	family,
}) => {
	await setUpAndSignIn(page);
	const origin = family.url;
	const upload = await page.request.post(`${origin}/api/v1/ambient/photos`, {
		headers: { origin },
		multipart: { files: { name: 'beach.png', mimeType: 'image/png', buffer: PIXEL } },
	});
	expect(upload.ok()).toBe(true);

	// The kitchen tablet: Deniz makes it a family device and stays signed in.
	const { context, page: tablet } = await signInAs(browser, family, ADMIN);
	await api(tablet, 'POST', '/api/v1/core/devices/trust', { name: 'Kitchen tablet' });
	await tablet.clock.install();
	const photosRead = tablet.waitForResponse((r) => r.url().endsWith('/api/v1/ambient/photos'));
	await tablet.goto('/add');
	await photosRead;
	const box = tablet.getByLabel('Something to add');
	await box.fill('Milk and bread');
	const send = await tablet.getByRole('button', { name: 'Send', exact: true }).boundingBox();
	if (!send) throw new Error('Send is not on the screen');

	// Five minutes (the family's Start after) without a touch: the photos cover the app.
	await tablet.clock.fastForward('05:01');
	const cover = tablet.getByTestId('ambient');
	await expect(cover).toBeVisible();

	// A tap right where Send is takes the photos away and presses nothing: the text is still there.
	const sent: string[] = [];
	tablet.on('request', (r) => {
		if (r.method() === 'POST') sent.push(new URL(r.url()).pathname);
	});
	await tablet.touchscreen.tap(send.x + send.width / 2, send.y + send.height / 2);
	await expect(cover).toHaveCount(0);
	await expect(tablet).toHaveURL(/\/add$/);
	await expect(box).toHaveValue('Milk and bread');
	expect(sent).toEqual([]);

	// Turned off for this device, nothing covers it however long it is left.
	await tablet.goto('/settings/devices');
	await tablet.getByRole('button', { name: 'Kitchen tablet', exact: true }).click();
	const meRead = tablet.waitForResponse((r) => r.url().endsWith('/api/v1/core/me'));
	await tablet.getByText('Photos when nobody is using it').click();
	await meRead;
	await expect(
		tablet.getByRole('switch', { name: 'Photos when nobody is using it' }),
	).not.toBeChecked();
	await tablet.goto('/add');
	await expect(tablet.getByLabel('Something to add')).toBeVisible();
	await tablet.clock.fastForward('10:00');
	await expect(tablet.getByTestId('ambient')).toHaveCount(0);
	await context.close();
});

test('a family device in its dark hours is black until a tap, which presses nothing', async ({
	page,
	browser,
	family,
}) => {
	await setUpAndSignIn(page);
	const { context, page: tablet } = await signInAs(browser, family, ADMIN);
	const device = await api<{ id: string }>(tablet, 'POST', '/api/v1/core/devices/trust', {
		name: 'Bedroom frame',
	});
	// Hours that cover the whole day but the last minute: it is dark whenever this runs.
	await api(page, 'POST', '/api/v1/actions/core.setDeviceSleep', {
		deviceId: device.id,
		sleep: { from: '00:00', until: '23:59' },
	});
	await tablet.goto('/add');
	const cover = tablet.getByRole('dialog', { name: /Screen is dark until/ });
	await expect(cover).toBeVisible();

	// A tap takes the black away and presses nothing under it.
	const sent: string[] = [];
	tablet.on('request', (r) => {
		if (r.method() === 'POST') sent.push(new URL(r.url()).pathname);
	});
	await tablet.touchscreen.tap(200, 300);
	await expect(cover).toHaveCount(0);
	await expect(tablet.getByLabel('Something to add')).toBeVisible();
	expect(sent).toEqual([]);
	await context.close();
});
