import type { Browser, BrowserContext, Page } from '@playwright/test';
import { api, FAMILY_TIME_ZONE } from './fixtures.ts';
import type { FamilyOS } from './server.ts';

/** Helpers for the display specs: a wall display paired the way the pairing screen does it. */

export interface PairedDisplay {
	context: BrowserContext;
	display: Page;
	/** The display's device id (for `core.setDisplayStyle`, `core.setDisplayTheme`). */
	deviceId: string;
}

/**
 * Pairs a new display (another browser, landscape, nobody signed in) with the capabilities an
 * admin ticked, confirmed by the signed-in admin on `page`. The display page is not opened yet.
 */
export async function pairDisplay(
	page: Page,
	browser: Browser,
	family: FamilyOS,
	options: {
		capabilities: string[];
		showNames?: boolean;
		name?: string;
		viewport?: { width: number; height: number };
		deviceScaleFactor?: number;
	},
): Promise<PairedDisplay> {
	const name = options.name ?? 'Kitchen';
	const context = await browser.newContext({
		baseURL: family.url,
		viewport: options.viewport ?? { width: 1280, height: 800 },
		deviceScaleFactor: options.deviceScaleFactor ?? 1,
		isMobile: false,
		hasTouch: false,
		locale: 'en-US',
		timezoneId: FAMILY_TIME_ZONE,
	});
	const headers = { origin: family.url };
	const start = await (
		await context.request.post('/api/v1/core/displays/pair', { headers })
	).json();
	await api(page, 'POST', '/api/v1/actions/core.confirmDisplayPairing', {
		userCode: start.userCode,
		name,
		capabilities: options.capabilities,
		showNames: options.showNames ?? false,
	});
	const poll = await context.request.post('/api/v1/core/displays/pair/poll', {
		headers,
		data: { deviceCode: start.deviceCode },
	});
	if ((await poll.json()).status !== 'paired') throw new Error('the display did not pair');
	const devices = await api<{ id: string; name: string; kind: string }[]>(
		page,
		'GET',
		'/api/v1/core/devices',
	);
	const deviceId = devices.find((d) => d.kind === 'kiosk' && d.name === name)?.id ?? '';
	const display = await context.newPage();
	return { context, display, deviceId };
}
