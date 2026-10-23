import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { pairDisplay } from '../support/display.ts';
import { startFakeHomeAssistant } from '../support/fake-ha.ts';
import { PRELOAD, startFakeOpenMeteo } from '../support/fake-open-meteo.ts';
import { api, expect, setUpAndSignIn, test } from '../support/fixtures.ts';
import { callTool, createAiAppKey } from '../support/mcp-app.ts';
import { signInAs } from '../support/members.ts';
import { clearFromShoppingLists, seedSampleFamily } from '../support/sample-data.ts';
import { day, standAt } from '../support/today.ts';

/**
 * The pictures of the README (`pnpm sweep:readme`), made from the same sample family as the
 * design sweep, at 15:20, with a fake Home Assistant. Not a test and not part of `pnpm e2e`.
 * Needs `pnpm build` first, and `cwebp` for the .webp files.
 *
 * - PNGs land in test-results/readme/; the .webp files the README shows are written to
 *   `docs/images/` (`FAMOS_README_OUT` replaces that folder);
 * - `FAMOS_README_ONLY=readme-today,readme-calendar` limits the pictures.
 *
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

// The server's weather comes from a fake Open-Meteo: it is told where it is before it starts.
const weather = await startFakeOpenMeteo();
process.env.FAMOS_FAKE_OPEN_METEO_PORT = String(weather.port);
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${PRELOAD}`.trim();

test.use({ isMobile: false, hasTouch: false, deviceScaleFactor: 2 });

/** Saves a picture as a PNG and as the .webp the README shows. */
async function save(name: string, take: (path: string) => Promise<unknown>) {
	await mkdir(PNG_DIR, { recursive: true });
	await mkdir(OUT, { recursive: true });
	const png = join(PNG_DIR, `${name}.png`);
	await take(png);
	// Quality steps down until the picture is small enough to load quickly on a README.
	const webp = join(OUT, `${name}.webp`);
	for (const quality of ['80', '72', '64', '56']) {
		execFileSync('cwebp', ['-quiet', '-q', quality, png, '-o', webp]);
		if (statSync(webp).size < MAX_BYTES) break;
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

async function open(page: Page, path: string, time = '15:20') {
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
		await api(page, 'POST', '/api/v1/actions/homeassistant.connect', { url: ha.url, token: TOKEN });
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

		// The week has more than today in it.
		for (const [offset, title, startTime, endTime, first] of [
			[-5, 'Football', '10:00', '11:30', 'Noah'],
			[-4, 'Piano lesson', '16:00', '17:00', 'Noah'],
			[-4, 'Team meeting', '10:30', '11:30', 'Deniz'],
			[-3, 'Swimming', '17:30', '18:30', 'Elif'],
			[-3, 'Dentist', '14:00', '15:00', 'Amy'],
			[-2, 'Parent meeting', '17:00', '18:00', 'Amy'],
			[-2, 'Robotics club', '15:30', '17:00', 'Elif'],
			[-1, 'Book club', '19:00', '21:00', 'Amy'],
			[1, 'Grandma’s birthday lunch', '12:00', '14:00', 'Deniz'],
		] as const)
			await api(page, 'POST', '/api/v1/actions/calendar.createEvent', {
				title,
				date: day(offset),
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
			await display.emulateMedia({ colorScheme: 'dark' });
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
				clip: { x: box.x + 2, y: box.y + 2, width: box.width - 4, height: box.height - 4 },
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
	} finally {
		await ha.close();
	}
	expect(true).toBe(true);
});
