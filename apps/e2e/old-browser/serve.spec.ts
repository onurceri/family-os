import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pairDisplay } from '../support/display.ts';
import { PRELOAD, startFakeOpenMeteo } from '../support/fake-open-meteo.ts';
import { api, setUpAndSignIn, test } from '../support/fixtures.ts';
import { seedSampleFamily } from '../support/sample-data.ts';
import { day } from '../support/today.ts';

/**
 * Not a test and not part of `pnpm e2e`: the sample family of the design sweep (members with
 * colors, events, lists, records, weather from a fake Open-Meteo) and a paired display, kept
 * running so browsers in Docker can open it. Run by scripts/old-browser/compare/run.sh:
 *
 *   FAMOS_COMPARE_DIR=<folder> pnpm --filter @famos/e2e exec playwright test -c old-browser.config.ts
 *
 * It writes `serve.json` (port, the signed-in cookies of Deniz and of the display, record ids,
 * today's date) into the folder, and runs until `done` appears there. The server listens on every
 * interface, so a container reaches it as host.docker.internal:<port>.
 */
const DIR = process.env.FAMOS_COMPARE_DIR;
if (DIR) {
	process.env.FAMOS_E2E_HOST = '0.0.0.0';
	// The server's weather comes from a fake Open-Meteo: it is told where it is before it starts.
	const weather = await startFakeOpenMeteo();
	process.env.FAMOS_FAKE_OPEN_METEO_PORT = String(weather.port);
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${PRELOAD}`.trim();
}

test('the sample family, for browsers in Docker', async ({ page, browser, family, model }) => {
	test.skip(!DIR, 'FAMOS_COMPARE_DIR is not set');
	test.setTimeout(3_600_000);
	const dir = DIR as string;
	page.setDefaultTimeout(15_000);
	await mkdir(dir, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 900 });
	await setUpAndSignIn(page);
	const ids = await seedSampleFamily(page, model);
	await api(page, 'POST', '/api/v1/actions/ambient.updateWeather', {
		enabled: true,
		place: { name: 'Riverton', latitude: 52.37, longitude: 4.9 },
	});
	const wall = await pairDisplay(page, browser, family, {
		capabilities: [
			'calendar.view',
			'lists.view',
			'chores.view',
			'board.view',
			'ambient.weather',
			'ambient.photos',
		],
		showNames: true,
		name: 'Kitchen',
		viewport: { width: 1280, height: 800 },
	});
	const plain = (list: { name: string; value: string; httpOnly: boolean }[]) =>
		list.map(({ name, value, httpOnly }) => ({ name, value, httpOnly }));
	await writeFile(
		join(dir, 'serve.json'),
		JSON.stringify({
			port: Number(new URL(family.url).port),
			day: day(0),
			ids,
			deviceId: wall.deviceId,
			cookies: plain(await page.context().cookies()),
			displayCookies: plain(await wall.context.cookies()),
		}),
	);
	for (let i = 0; i < 3600 && !existsSync(join(dir, 'done')); i++) await page.waitForTimeout(1000);
	await wall.context.close();
});
