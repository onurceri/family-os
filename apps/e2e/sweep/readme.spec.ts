import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { pairDisplay } from '../support/display.ts';
import { startFakeHomeAssistant } from '../support/fake-ha.ts';
import { api, expect, setUpAndSignIn, test } from '../support/fixtures.ts';
import { signInAs } from '../support/members.ts';
import { seedSampleFamily } from '../support/sample-data.ts';
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
 * (build output, rewritten by the next `pnpm build`).
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const PNG_DIR = resolve(ROOT, 'apps/e2e/test-results/readme');
const OUT = process.env.FAMOS_README_OUT ?? join(ROOT, 'docs/images');
const ONLY = process.env.FAMOS_README_ONLY?.split(',').map((s) => s.trim());
const wanted = (name: string) => !ONLY || ONLY.includes(name);

/** A card is 16:10; the window of a page shot whole is this size, a crop of Today 800 x 500. */
const WINDOW = { width: 1100, height: 688 };
const TOKEN = 'readme-token';

test.use({ isMobile: false, hasTouch: false, deviceScaleFactor: 2 });

/** Saves a picture as a PNG and as the .webp the README shows. */
async function save(name: string, take: (path: string) => Promise<unknown>) {
	await mkdir(PNG_DIR, { recursive: true });
	await mkdir(OUT, { recursive: true });
	const png = join(PNG_DIR, `${name}.png`);
	await take(png);
	execFileSync('cwebp', ['-quiet', '-q', '80', png, '-o', join(OUT, `${name}.webp`)]);
}

/** A picture of `name` cut out of the page: `x` and `y` are its top left corner. */
const card = (
	page: Page,
	name: string,
	x: number,
	y: number,
	size: { width: number; height: number },
) => save(name, (path) => page.screenshot({ path, clip: { x, y, ...size } }));

async function open(page: Page, path: string, time = '15:20') {
	await standAt(page, time);
	await page.goto(path);
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(400);
}

test('the pictures of the README', async ({ page, browser, family, model }) => {
	test.setTimeout(300_000);
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
		])
			await api(page, 'POST', '/api/v1/actions/homeassistant.addItem', { entityId, label });

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
			[-4, 'Team meeting', '09:00', '10:00', 'Deniz'],
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

		// Today: the clock, the day in a sentence, who is home and the next thing.
		if (wanted('readme-today')) {
			await open(page, '/');
			await card(page, 'readme-today', 280, 20, { width: 800, height: 500 });
		}

		// Calendar: a week, from the morning on.
		if (wanted('readme-calendar')) {
			await page.setViewportSize(WINDOW);
			await open(page, '/calendar');
			await page.evaluate(() => {
				for (const el of document.querySelectorAll('main *'))
					if (
						el.scrollHeight > el.clientHeight + 100 &&
						getComputedStyle(el).overflowY !== 'visible'
					)
						el.scrollTop = 420;
			});
			await page.waitForTimeout(300);
			await save('readme-calendar', (path) => page.screenshot({ path }));
		}

		// Quick add: what it found in a shared message, as cards to tick.
		if (wanted('readme-quick-add')) {
			await page.setViewportSize(WINDOW);
			await open(page, '/add');
			// The newsletter's two cards, under the pending ones.
			await page
				.getByText('Class newsletter')
				.first()
				.evaluate((el) => {
					el.scrollIntoView({ block: 'start' });
				});
			await page.waitForTimeout(300);
			await save('readme-quick-add', (path) => page.screenshot({ path }));
		}

		// Home Assistant: what the family chose to show, and who shares being home.
		if (wanted('readme-home-assistant')) {
			await page.setViewportSize(WINDOW);
			await open(page, '/settings/home-assistant');
			await page
				.getByText('What to show', { exact: true })
				.first()
				.evaluate((el) => {
					el.scrollIntoView({ block: 'start' });
				});
			await page.waitForTimeout(300);
			await save('readme-home-assistant', (path) => page.screenshot({ path }));
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
				],
				showNames: true,
				name: 'Kitchen',
				viewport: { width: 1280, height: 800 },
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
	} finally {
		await ha.close();
	}
	expect(true).toBe(true);
});
