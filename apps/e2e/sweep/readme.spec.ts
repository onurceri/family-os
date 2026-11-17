import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { pairDisplay } from '../support/display.ts';
import { startFakeHomeAssistant } from '../support/fake-ha.ts';
import { PRELOAD, startFakeOpenMeteo } from '../support/fake-open-meteo.ts';
import { api, expect, FAMILY_TIME_ZONE, setUpAndSignIn, test } from '../support/fixtures.ts';
import { callTool, createAiAppKey } from '../support/mcp-app.ts';
import { signInAs } from '../support/members.ts';
import { clearFromShoppingLists, seedSampleFamily } from '../support/sample-data.ts';
import { day, standAt } from '../support/today.ts';

/**
 * The eight pictures of the README (`pnpm sweep:readme`), made from the same sample family as the
 * design sweep, at 15:20, with a fake Home Assistant. Not a test and not part of `pnpm e2e`.
 * Needs `pnpm build` first, and `cwebp` for the .webp files. The "README pictures" workflow
 * (.github/workflows/readme-pictures.yml) runs it after a release and opens a pull request with
 * what changed.
 *
 * - PNGs land in test-results/readme/; the .webp files the README shows are written to
 *   `docs/images/` (`FAMOS_README_OUT` replaces that folder);
 * - `FAMOS_README_ONLY=readme-today,readme-calendar` limits the pictures (`hero-kitchen` is the
 *   one at the top of the README).
 *
 * `hero-kitchen` sets real screenshots of Today on a phone and of a paired display into a drawn
 * kitchen (plain CSS, with the app's own serif for the headline), at 1920 x 1080.
 * The six cards share one aspect (16:10) and are cropped to what their line says. Home Assistant
 * is released on its own and is not in the built image, so the script places the package it built
 * (extensions/homeassistant/dist) next to the others and lists it as offered, in dist/extensions
 * (build output, rewritten by the next `pnpm build`). The weather comes from a fake Open-Meteo
 * (support/fake-open-meteo.ts). "Your own AI" replays what a real MCP client did
 * (readme-agent.json, recorded with Hermes Agent in Docker against readme-agent-server.spec.ts)
 * against the sample family, so FamilyOS holds the suggestions it made.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const PNG_DIR = resolve(ROOT, 'apps/e2e/test-results/readme');
const OUT = process.env.FAMOS_README_OUT ?? join(ROOT, 'docs/images');
const ONLY = process.env.FAMOS_README_ONLY?.split(',').map((s) => s.trim());
const wanted = (name: string) => !ONLY || ONLY.includes(name);

/** A window narrow enough for the icon sidebar, so a card is not mostly sidebar. */
const TABLET = { width: 920, height: 600 };
const TOKEN = 'readme-token';
const MAX_BYTES = 150_000;
/** The hero is a 1920 x 1080 composition of two screens, so it gets more room. */
const HERO_MAX_BYTES = 250_000;
const FONT_DIR = join(ROOT, 'packages/ui/node_modules/@fontsource');

// The server's weather comes from a fake Open-Meteo: it is told where it is before it starts.
const weather = await startFakeOpenMeteo();
process.env.FAMOS_FAKE_OPEN_METEO_PORT = String(weather.port);
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${PRELOAD}`.trim();

test.use({ isMobile: false, hasTouch: false, deviceScaleFactor: 2 });

/** Saves a picture as a PNG and as the .webp the README shows. */
async function save(name: string, take: (path: string) => Promise<unknown>, maxBytes = MAX_BYTES) {
	await mkdir(PNG_DIR, { recursive: true });
	await mkdir(OUT, { recursive: true });
	const png = join(PNG_DIR, `${name}.png`);
	await take(png);
	// Quality steps down until the picture is small enough to load quickly on a README.
	const webp = join(OUT, `${name}.webp`);
	for (const quality of ['80', '72', '64', '56', '48']) {
		execFileSync('cwebp', ['-quiet', '-q', quality, png, '-o', webp]);
		if (statSync(webp).size < maxBytes) break;
	}
}

/** A cut of the page, 16:10, from `x` and `y` (by default the page without the icon sidebar of a 920 px window). */
const main = (page: Page, name: string, y = 0, width = 836, x = 84) =>
	save(name, (path) =>
		page.screenshot({
			path,
			clip: { x, y, width, height: Math.round(width / 1.6) },
		}),
	);

/**
 * A board note leans by an angle taken from its id, which is random in every run, so the same
 * picture would come out a little different each time. Here every note leans the same way.
 */
const steadied = new WeakSet<Page>();
async function steadyNotes(page: Page) {
	if (steadied.has(page)) return;
	steadied.add(page);
	await page.addInitScript(() => {
		const add = () => {
			const style = document.createElement('style');
			style.textContent = '[style*="--tilt"] { --tilt: -1deg !important; }';
			document.head.append(style);
		};
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
		else add();
	});
}

async function open(page: Page, path: string, time = '15:20') {
	await steadyNotes(page);
	await standAt(page, time);
	await page.goto(path);
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(400);
}

/** Today's blocks that are not in `keep`: what a picture of part of Today hides. */
async function blockIds(page: Page, keep: string[]) {
	await open(page, '/settings/appearance');
	const all = await page
		.locator('#today-blocks input[role="switch"]')
		.evaluateAll((inputs) => inputs.map((i) => i.id.replace(/^my-blocks-/, '')));
	return all.filter((id) => !keep.includes(id));
}

test('the pictures of the README', async ({ page, browser, family, model }) => {
	test.setTimeout(300_000);
	page.setDefaultTimeout(20_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await setUpAndSignIn(page);

	// Home Assistant is released on its own: place the package built here, then install it.
	const built = join(ROOT, 'extensions/homeassistant/dist');
	const shipped = join(ROOT, 'dist/extensions/homeassistant');
	if (!existsSync(built)) throw new Error('Build first: pnpm build');
	if (!existsSync(shipped)) cpSync(built, shipped, { recursive: true });
	const list = join(ROOT, 'dist/extensions/extensions.json');
	const listed = JSON.parse(readFileSync(list, 'utf8')) as { offered: string[] };
	if (!listed.offered.includes('homeassistant')) {
		listed.offered.push('homeassistant');
		writeFileSync(list, JSON.stringify(listed, null, '\t'));
	}
	await family.stop();
	const installed = await family.cli(['extensions', 'install', 'homeassistant']);
	if (installed.code !== 0) throw new Error(installed.output);
	await family.start();

	await seedSampleFamily(page, model);
	// A mild, partly cloudy afternoon, from the fake Open-Meteo.
	await api(page, 'POST', '/api/v1/actions/ambient.updateWeather', {
		enabled: true,
		place: { name: 'Riverton', latitude: 52.37, longitude: 4.9 },
	});

	const ha = await startFakeHomeAssistant(TOKEN, {
		'sensor.living_room_temperature': {
			state: '21.5',
			attributes: {
				unit_of_measurement: '°C',
				device_class: 'temperature',
				friendly_name: 'Living room temperature',
			},
		},
		'sensor.kitchen_humidity': {
			state: '48',
			attributes: {
				unit_of_measurement: '%',
				device_class: 'humidity',
				friendly_name: 'Kitchen humidity',
			},
		},
		'binary_sensor.front_door': {
			state: 'off',
			attributes: { device_class: 'door', friendly_name: 'Front door' },
		},
		'light.kitchen': {
			state: 'on',
			attributes: { friendly_name: 'Kitchen light', supported_color_modes: ['onoff'] },
		},
		'lock.back_door': { state: 'locked', attributes: { friendly_name: 'Back door' } },
		'sensor.washing_machine_power': {
			state: '0',
			attributes: { unit_of_measurement: 'W', device_class: 'power', friendly_name: 'Washer' },
		},
		'person.deniz': { state: 'home', attributes: { friendly_name: 'Deniz' } },
		'person.amy': { state: 'home', attributes: { friendly_name: 'Amy' } },
		'person.elif': { state: 'not_home', attributes: { friendly_name: 'Elif' } },
	});
	try {
		await api(page, 'PUT', '/api/v1/homeassistant/connection', { url: ha.url, token: TOKEN });
		for (const [entityId, label] of [
			['sensor.living_room_temperature', 'Living room'],
			['sensor.kitchen_humidity', 'Kitchen humidity'],
			['binary_sensor.front_door', 'Front door'],
			['lock.back_door', 'Back door'],
			['light.kitchen', 'Kitchen light'],
		]) {
			const added = await api<{ output: { id: string } }>(
				page,
				'POST',
				'/api/v1/actions/homeassistant.addItem',
				{ entityId, label },
			);
			// The family allows switching the kitchen light, and nothing else.
			if (entityId === 'light.kitchen')
				await api(page, 'POST', '/api/v1/actions/homeassistant.setItemControl', {
					id: added.output.id,
					control: true,
					confirm: false,
				});
		}

		// Who is home: each person chooses to share it, so each signs in and does.
		const members = await api<{ id: string; displayName: string }[]>(
			page,
			'GET',
			'/api/v1/core/members',
		);
		const idOf = (first: string) => members.find((m) => m.displayName.startsWith(first))?.id ?? '';
		for (const [first, person] of [
			['Deniz', 'person.deniz'],
			['Amy', 'person.amy'],
			['Elif', 'person.elif'],
		] as const)
			await api(page, 'POST', '/api/v1/actions/homeassistant.linkPerson', {
				memberId: idOf(first),
				personEntity: person,
			});
		await api(page, 'POST', '/api/v1/actions/homeassistant.setMySharing', {
			level: 'home',
			onDisplays: true,
		});
		for (const first of ['Amy', 'Elif']) {
			const email = `${first.toLowerCase()}@example.com`;
			const password = 'correct horse battery';
			await api(page, 'PUT', `/api/v1/core/members/${idOf(first)}/password`, { email, password });
			const { context, page: own } = await signInAs(browser, family, { email, password });
			await api(own, 'POST', '/api/v1/actions/homeassistant.setMySharing', {
				level: 'home',
				onDisplays: true,
			});
			await context.close();
		}

		await api(page, 'POST', '/api/v1/actions/core.setFamilyStyle', { style: 'broadsheet' });
		await page.emulateMedia({ colorScheme: 'light' });

		// The week has more than today in it: events on fixed weekdays of the calendar's week
		// (Sunday first), so the picture does not depend on the day the script runs.
		const sunday = -new Date(`${day(0)}T12:00:00Z`).getUTCDay();
		for (const [weekday, title, startTime, endTime, first] of [
			[0, 'Bike ride', '10:00', '11:30', 'Noah'],
			[2, 'Eye test', '14:00', '15:00', 'Amy'],
			[3, 'Parent meeting', '17:00', '18:00', 'Amy'],
			[3, 'Robotics club', '15:30', '17:00', 'Elif'],
			[4, 'Team meeting', '10:30', '11:30', 'Deniz'],
			[4, 'Guitar lesson', '16:00', '17:00', 'Noah'],
			[5, 'Choir practice', '17:30', '18:30', 'Elif'],
			[5, 'Book club', '19:00', '21:00', 'Amy'],
			[6, 'Grandma’s birthday lunch', '12:00', '14:00', 'Deniz'],
		] as const)
			await api(page, 'POST', '/api/v1/actions/calendar.createEvent', {
				title,
				date: day(sunday + weekday),
				startTime,
				endTime,
				memberIds: [idOf(first)],
			});

		const hide = (hidden: string[] | null) =>
			api(page, 'POST', '/api/v1/actions/core.setMyTodayBlocks', { hidden });
		// Today: the clock, the day in a sentence, the weather and the next thing, without the sidebar.
		if (wanted('readme-today')) {
			await page.setViewportSize({ width: 1160, height: 760 });
			await hide(await blockIds(page, ['clock', 'greeting', 'weather', 'next']));
			await open(page, '/');
			await main(page, 'readme-today', 10, 890, 270);
			await hide(null);
		}

		// Calendar: a week, from the morning on.
		if (wanted('readme-calendar')) {
			await page.setViewportSize({ width: 1100, height: 520 });
			await open(page, '/calendar');
			// The week from 10 AM, just under the day headers, so no event is cut at the top.
			await page.evaluate(() => {
				const leaf = (text: string) =>
					[...document.querySelectorAll('main *')].find(
						(e) =>
							e.children.length === 0 && e.textContent?.trim().toLowerCase() === text.toLowerCase(),
					);
				const hour = leaf('10 AM');
				const header = leaf('all day')?.parentElement;
				if (!hour || !header) throw new Error('the week grid was not found');
				let scroller = hour.parentElement;
				while (scroller && scroller.scrollHeight <= scroller.clientHeight + 100)
					scroller = scroller.parentElement;
				if (scroller)
					scroller.scrollTop +=
						hour.getBoundingClientRect().top - header.getBoundingClientRect().bottom - 6;
			});
			await page.waitForTimeout(300);
			await main(page, 'readme-calendar', 0, 806, 270);
		}

		// Quick add: one whole capture group, from its header to its Add selected row.
		if (wanted('readme-quick-add')) {
			await page.setViewportSize({ width: 1440, height: 1800 });
			await open(page, '/add');
			const group = page.getByTestId('capture-group').filter({ hasText: 'Parent meeting' });
			await group.scrollIntoViewIfNeeded();
			const heading = page.getByText('Class newsletter', { exact: true }).first();
			await heading.evaluate((el) => el.scrollIntoView({ block: 'start' }));
			await page.evaluate(() => window.scrollBy(0, -40));
			await page.waitForTimeout(300);
			const top = (await heading.boundingBox())?.y ?? 0;
			const box = await group.boundingBox();
			if (!box) throw new Error('the capture group is not on the page');
			const y = top - 24;
			const height = box.y + box.height + 32 - y;
			const width = Math.round(height * 1.6);
			const x = Math.max(0, box.x + box.width / 2 - width / 2);
			await save('readme-quick-add', (path) =>
				page.screenshot({ path, clip: { x, y, width, height } }),
			);
		}

		// Home Assistant as the family sees it: who is home, and the house's values and a switch.
		if (wanted('readme-home-assistant')) {
			await page.setViewportSize(TABLET);
			await hide(
				await blockIds(page, ['family', 'homeassistant.presence', 'homeassistant.values']),
			);
			await open(page, '/');
			await main(page, 'readme-home-assistant', 12);
			await hide(null);
		}

		// A wall display in the Wall style, at night, paired like a real one.
		if (wanted('readme-display')) {
			const wall = await pairDisplay(page, browser, family, {
				capabilities: [
					'calendar.view',
					'lists.view',
					'chores.view',
					'board.view',
					'homeassistant.view',
					'ambient.weather',
				],
				showNames: true,
				name: 'Kitchen',
				viewport: { width: 1280, height: 800 },
				deviceScaleFactor: 2,
			});
			await api(page, 'POST', '/api/v1/actions/core.setDisplayStyle', {
				deviceId: wall.deviceId,
				style: 'wall',
			});
			const { display } = wall;
			// A display follows the clock by default (daylight at 15:20), so the night is chosen.
			await display.addInitScript(() => localStorage.setItem('famos.mode', 'night'));
			await steadyNotes(display);
			await standAt(display, '15:20');
			await display.goto('/display');
			// The display claims its pairing on its next poll (every five seconds).
			await expect(display.getByTestId('today-body')).toHaveAttribute('data-settled', 'true', {
				timeout: 40_000,
			});
			await display.waitForTimeout(800);
			await save('readme-display', (path) => display.screenshot({ path }));
			await wall.context.close();
		}
		// Today's three styles side by side, each shot whole and set in one row.
		if (wanted('readme-styles')) {
			await page.setViewportSize({ width: 1440, height: 900 });
			const shots: { name: string; src: string }[] = [];
			for (const [style, name, scheme] of [
				['broadsheet', 'Broadsheet', 'light'],
				['lanes', 'Lanes', 'light'],
				['wall', 'Wall', 'dark'],
			] as const) {
				await api(page, 'POST', '/api/v1/actions/core.setFamilyStyle', { style });
				await page.emulateMedia({ colorScheme: scheme });
				await open(page, '/');
				await page.waitForFunction((v) => document.documentElement.dataset.style === v, style);
				const png = await page.screenshot();
				shots.push({ name, src: `data:image/png;base64,${png.toString('base64')}` });
			}
			await api(page, 'POST', '/api/v1/actions/core.setFamilyStyle', { style: 'broadsheet' });
			await page.emulateMedia({ colorScheme: 'light' });
			const row = await page.context().newPage();
			await row.setViewportSize({ width: 1800, height: 420 });
			await row.setContent(
				`<body style="margin:0;display:flex;gap:12px;padding:0 0 0;background:#fff;font:600 20px system-ui,sans-serif">${shots
					.map(
						(s) =>
							`<figure style="margin:0;width:592px"><img src="${s.src}" style="width:592px;display:block;border:1px solid #d8d6d0;border-radius:8px"><figcaption style="text-align:center;padding-top:6px">${s.name}</figcaption></figure>`,
					)
					.join('')}</body>`,
			);
			await save('readme-styles', (path) => row.screenshot({ path }));
			await row.close();
		}
		// Your own AI: what a real Hermes Agent did (sweep/readme-agent.json, recorded in Docker
		// against readme-agent-server.spec.ts; its chat is the committed readme-hermes.png, since Hermes
		// cannot be re-run here) is replayed against the sample family, so FamilyOS holds the same
		// suggestion; the card puts the two side by side.
		if (wanted('readme-your-ai')) {
			const recorded = JSON.parse(
				await readFile(join(import.meta.dirname, 'readme-agent.json'), 'utf8'),
			) as { calls: { tool: string; input: unknown }[] };
			const hermes = await readFile(join(import.meta.dirname, 'readme-hermes.png'));
			// As in the recording: milk and eggs are not on the list yet.
			await clearFromShoppingLists(page, ['Milk', 'Eggs']);
			const secret = await createAiAppKey(page, 'Hermes Agent');
			for (const call of recorded.calls) await callTool(family.url, secret, call.tool, call.input);
			// The suggestion at a phone-sized width, from its app's title to its buttons.
			await page.setViewportSize({ width: 340, height: 1200 });
			await open(page, '/add');
			const group = page.getByRole('article', { name: 'Hermes Agent' }).first();
			await group.scrollIntoViewIfNeeded();
			const box = await group.boundingBox();
			if (!box) throw new Error('the suggestion is not on the page');
			const shot = await page.screenshot({
				clip: { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 },
			});
			const canvas = await browser.newContext({
				viewport: { width: 864, height: 540 },
				deviceScaleFactor: 2,
			});
			const view = await canvas.newPage();
			const png = (data: Buffer) => `data:image/png;base64,${data.toString('base64')}`;
			await view.setContent(`<!doctype html><html><head><style>
				html, body { margin: 0; width: 864px; height: 540px; overflow: hidden; background: #ecebe6; font: 600 17px/1.2 system-ui, sans-serif; color: #2b2a27; }
				main { display: flex; align-items: flex-start; justify-content: space-between; padding: 40px 16px 0; height: 100%; box-sizing: border-box; }
				figure { margin: 0; }
				figure:first-child { width: 480px; }
				figure:last-child { width: 344px; }
				figcaption { text-align: center; padding-bottom: 12px; white-space: nowrap; }
				img { width: 100%; display: block; border-radius: 10px; }
				.arrow { align-self: center; font-size: 40px; color: #6b6a64; }
			</style></head><body><main>
				<figure><figcaption>1 · Ask Hermes Agent (or any MCP app)</figcaption><img src="${png(hermes)}"></figure>
				<div class="arrow">&rsaquo;</div>
				<figure><figcaption>2 · FamilyOS waits for your approval</figcaption><img src="${png(shot)}" style="border:1px solid #d8d6d0"></figure>
			</main></body></html>`);
			await save('readme-your-ai', (path) => view.screenshot({ path }));
			await canvas.close();
		}

		// The hero: Today on a phone and on a paired display, set into a drawn kitchen.
		if (wanted('hero-kitchen')) {
			const png = (data: Buffer) => `data:image/png;base64,${data.toString('base64')}`;
			const font = async (file: string) =>
				`data:font/woff2;base64,${(await readFile(join(FONT_DIR, file))).toString('base64')}`;
			const serif = 'instrument-serif/files/instrument-serif-latin-400';

			// The phone: Today at 390 px, in Broadsheet, in daylight.
			await api(page, 'POST', '/api/v1/actions/core.setFamilyStyle', { style: 'broadsheet' });
			const phoneContext = await browser.newContext({
				baseURL: family.url,
				storageState: await page.context().storageState(),
				viewport: { width: 390, height: 844 },
				deviceScaleFactor: 3,
				isMobile: false,
				hasTouch: false,
				locale: 'en-US',
				timezoneId: FAMILY_TIME_ZONE,
				colorScheme: 'light',
			});
			const phone = await phoneContext.newPage();
			// Without what waits for Deniz, the phone shows the same next thing as the wall.
			await hide(['needs']);
			await open(phone, '/');
			const phoneShot = await phone.screenshot();
			await hide(null);
			await phoneContext.close();

			// The tablet: a paired display, in daylight.
			const wall = await pairDisplay(page, browser, family, {
				capabilities: [
					'calendar.view',
					'lists.view',
					'chores.view',
					'board.view',
					'homeassistant.view',
					'ambient.weather',
				],
				showNames: true,
				name: 'Kitchen tablet',
				viewport: { width: 1280, height: 800 },
				deviceScaleFactor: 2,
			});
			await api(page, 'POST', '/api/v1/actions/core.setDisplayStyle', {
				deviceId: wall.deviceId,
				style: 'broadsheet',
			});
			await wall.display.emulateMedia({ colorScheme: 'light' });
			await steadyNotes(wall.display);
			await standAt(wall.display, '15:20');
			await wall.display.goto('/display');
			await expect(wall.display.getByTestId('today-body')).toHaveAttribute('data-settled', 'true', {
				timeout: 40_000,
			});
			await wall.display.waitForTimeout(800);
			const tabletShot = await wall.display.screenshot();
			await wall.context.close();

			const scene = await browser.newContext({
				viewport: { width: 1920, height: 1080 },
				deviceScaleFactor: 1,
			});
			const view = await scene.newPage();
			await view.setContent(`<!doctype html><html><head><style>
				@font-face { font-family: 'Hero Serif'; font-style: normal; font-weight: 400; src: url(${await font(`${serif}-normal.woff2`)}) format('woff2'); }
				@font-face { font-family: 'Hero Serif'; font-style: italic; font-weight: 400; src: url(${await font(`${serif}-italic.woff2`)}) format('woff2'); }
				html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; }
				body { position: relative; font-family: system-ui, sans-serif; background: linear-gradient(#f6f0e6, #efe5d5); }
				h1 { position: absolute; top: 36px; left: 0; width: 1920px; margin: 0; text-align: center; font: 400 92px/1.1 'Hero Serif', serif; letter-spacing: -1px; color: #211e1a; }
				.tiles { position: absolute; left: 0; top: 830px; width: 1920px; height: 125px; background-color: #f3ebdd;
					background-image: linear-gradient(#e4d9c6 2px, transparent 2px), linear-gradient(90deg, #e4d9c6 2px, transparent 2px); background-size: 120px 62px; }
				.counter { position: absolute; left: 0; top: 955px; width: 1920px; height: 26px; background: #d6c3a4; box-shadow: 0 -2px 0 #c4b08f inset; }
				.cabinets { position: absolute; left: 0; top: 981px; width: 1920px; height: 99px; background: #e6d9c4; }
				.door { position: absolute; top: 24px; width: 350px; height: 90px; background: #eadfcb; border: 2px solid #d8c9b0; border-radius: 6px; }
				.door::after { content: ''; position: absolute; left: 50%; top: 18px; width: 62px; height: 6px; margin-left: -31px; border-radius: 3px; background: #b9a98c; }
				.phone { position: absolute; left: 238px; top: 222px; width: 348px; padding: 12px; box-sizing: border-box; border-radius: 58px; background: #141414; transform: rotate(-4deg); box-shadow: 0 30px 50px rgba(60, 40, 20, .28), 0 0 0 2px #2a2a2a inset; }
				.phone .screen { position: relative; border-radius: 46px; overflow: hidden; height: 700px; background: #ecebe6; }
				.phone img { display: block; width: 324px; }
				.pill { position: absolute; left: 50%; top: 12px; width: 96px; height: 28px; margin-left: -48px; border-radius: 14px; background: #0b0b0b; }
				.tablet { position: absolute; left: 744px; top: 200px; width: 1088px; padding: 14px; box-sizing: border-box; border-radius: 26px; background: #1b1b1b; box-shadow: 0 24px 44px rgba(60, 40, 20, .25), 0 0 0 2px #333 inset; }
				.tablet img { display: block; width: 1060px; border-radius: 8px; }
				.label { position: absolute; left: 744px; top: 906px; width: 1088px; text-align: center; font: 600 20px/1 system-ui, sans-serif; color: rgba(60, 45, 30, .38); }
				.plant { position: absolute; left: 1836px; top: 788px; }
			</style></head><body>
				<h1>On every phone. <em>On the kitchen wall.</em></h1>
				<div class="tiles"></div><div class="counter"></div>
				<div class="cabinets">${[0, 1, 2, 3, 4].map((i) => `<div class="door" style="left:${i * 414 + 24}px"></div>`).join('')}</div>
				<div class="tablet"><img src="${png(tabletShot)}"></div>
				<div class="label">Kitchen</div>
				<div class="phone"><div class="screen"><img src="${png(phoneShot)}"><div class="pill"></div></div></div>
				<svg class="plant" width="92" height="167" viewBox="0 0 108 196">
					<g fill="#5f9a52"><path d="M54 140 C30 110 28 60 52 20 C76 60 76 110 54 140Z"/><path d="M50 150 C20 135 8 100 14 62 C44 84 56 118 50 150Z" fill="#4f8845"/><path d="M58 150 C88 140 106 108 100 78 C70 92 56 118 58 150Z" fill="#6fa95f"/></g>
					<path d="M30 150 H86 L80 196 H36Z" fill="#c4724f"/><rect x="26" y="144" width="64" height="12" rx="3" fill="#b3623f"/>
				</svg>
			</body></html>`);
			await view.evaluate(() => document.fonts.ready);
			await save('hero-kitchen', (path) => view.screenshot({ path }), HERO_MAX_BYTES);
			await scene.close();
			await api(page, 'POST', '/api/v1/actions/core.setFamilyStyle', { style: 'broadsheet' });
		}
	} finally {
		await ha.close();
	}
	expect(true).toBe(true);
});
