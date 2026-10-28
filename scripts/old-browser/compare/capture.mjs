// Takes full-page pictures of every page of a running FamilyOS (the sample family that
// apps/e2e/old-browser/serve.spec.ts prepares), day and night, at three widths. The same file runs
// in the repo's Chromium and in Chromium 106 (Playwright 1.26), so it uses only calls both have;
// diff.mjs pairs the two folders. See docs/releasing.md.
//
//   FAMOS_URL     the family's address as this browser sees it (http://host.docker.internal:<port>)
//   FAMOS_SERVE   the serve.json the family wrote (cookies, record ids, today's date)
//   FAMOS_OUT     where the pictures go
//   FAMOS_RESOLVE=1   map host.docker.internal to this machine (a browser outside Docker)
//   FAMOS_STYLES  Today styles to take, comma-separated (default broadsheet,lanes,wall)
//   FAMOS_ONLY    only these page names, comma-separated (see PAGES; "display" is the paired display)
//   FAMOS_WIDTHS  default 400,1024,1440
//
// Pictures: <page>__<style>-<day|night>-<width>.png. Pages other than Today and the display are
// taken in the first style only: the styles set Today's composition.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Playwright from the repo's root on the host (a stray copy of 1.26 next to these scripts would
 * otherwise win); in Docker the script is copied alone, next to the 1.26 it installs.
 */
function loadPlaywright() {
	try {
		return createRequire(new URL('../../../package.json', import.meta.url))('playwright-core');
	} catch {
		return createRequire(import.meta.url)('playwright-core');
	}
}
const { chromium } = loadPlaywright();

const env = process.env;
const base = env.FAMOS_URL;
if (!base || !env.FAMOS_SERVE || !env.FAMOS_OUT)
	throw new Error('Set FAMOS_URL, FAMOS_SERVE and FAMOS_OUT');
const serve = JSON.parse(readFileSync(env.FAMOS_SERVE, 'utf8'));
const out = env.FAMOS_OUT;
const list = (value, fallback) =>
	(value ?? fallback)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
const STYLES = list(env.FAMOS_STYLES, 'broadsheet,lanes,wall');
const ONLY = env.FAMOS_ONLY ? list(env.FAMOS_ONLY, '') : undefined;
const WIDTHS = list(env.FAMOS_WIDTHS, '400,1024,1440').map(Number);
const HEIGHT = { 400: 860, 1024: 768, 1440: 900 };
// The browser's clock stands here in both runs: today at 15:20 in the family's zone.
const NOW = new Date(`${serve.day}T15:20:00+03:00`).getTime();

const press = (name) => async (page) => {
	const button = page.locator(`button:text-is("${name}")`).first();
	if (await button.isVisible().catch(() => false)) {
		await button.click();
		await page.waitForTimeout(300);
	}
};

/** Every route of the app (the design sweep's list; `phone` pages only at 400 px). */
const PAGES = [
	{ name: 'today', path: '/', today: true },
	{ name: 'quick-add', path: '/add' },
	{ name: 'board', path: '/board' },
	{ name: 'calendar-week', path: '/calendar' },
	{ name: 'calendar-day', path: '/calendar', prep: press('Day') },
	{ name: 'calendar-month', path: '/calendar', prep: press('Month') },
	{ name: 'lists-tasks', path: '/lists/tasks' },
	{ name: 'lists-shopping', path: '/lists/shopping' },
	{ name: 'assistant', path: '/assistant?ask' },
	{ name: 'assistant-open', path: `/assistant?thread=${serve.ids.thread}` },
	{ name: 'chores', path: '/chores' },
	{ name: 'vehicles', path: '/vehicles' },
	{ name: 'vehicle-one', path: `/vehicles/${serve.ids.vehicle}` },
	{ name: 'home', path: '/home' },
	{ name: 'home-one', path: `/home/${serve.ids.home}` },
	{ name: 'pets', path: '/pets' },
	{ name: 'pet-one', path: `/pets/${serve.ids.pet}` },
	{ name: 'kitchen', path: '/kitchen' },
	{ name: 'kitchen-plan', path: '/kitchen/plan' },
	{ name: 'recipe-one', path: `/kitchen/recipes/${serve.ids.recipe}` },
	{ name: 'notifications', path: '/notifications' },
	{ name: 'more', path: '/more', phone: true },
	{ name: 'more-you', path: '/more/you', phone: true },
	{ name: 'more-family', path: '/more/family', phone: true },
	{ name: 'more-ai', path: '/more/ai', phone: true },
	{ name: 'more-system', path: '/more/system', phone: true },
	...[
		'profile',
		'appearance',
		'notifications',
		'memory',
		'calendar-feed',
		'connected-apps',
		'members',
		'roles',
		'devices',
		'extensions',
		'region',
		'theme',
		'calendars',
		'ai',
		'ai/privacy',
		'ai/usage',
		'ai/activity',
		'auto-approval',
		'backups',
		'email',
		'telegram',
	].map((name) => ({ name: `s-${name.replace('/', '-')}`, path: `/settings/${name}` })),
];

// Nothing moves, blinks or fades while the picture is taken.
const FREEZE =
	'*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' +
	// A whole-page picture would draw the phone's tab bar and the docked add field over the middle.
	' nav.fixed.bottom-0, [data-dock] { position: static !important; }' +
	' @media (width < 48rem) { [data-dock] { order: 99; } }';

const cookiesFor = (list) =>
	list.map((c) => ({ name: c.name, value: c.value, httpOnly: c.httpOnly, url: base }));

const browser = await chromium.launch({
	args: env.FAMOS_RESOLVE ? ['--host-resolver-rules=MAP host.docker.internal 127.0.0.1'] : [],
});
console.log(`Chromium ${browser.version()}`);
mkdirSync(out, { recursive: true });
const problems = [];
let count = 0;

async function open(cookies, width) {
	const context = await browser.newContext({
		viewport: { width, height: HEIGHT[width] ?? 800 },
		locale: 'en-US',
		timezoneId: 'Europe/Istanbul',
		deviceScaleFactor: 1,
	});
	await context.addCookies(cookiesFor(cookies));
	// A fixed clock (the same in both runs); timers still run.
	await context.addInitScript((now) => {
		window.Date = new Proxy(Date, {
			construct: (Real, args) => (args.length ? new Real(...args) : new Real(now)),
			apply: (Real) => new Real(now).toString(),
			get: (Real, key) => (key === 'now' ? () => now : Reflect.get(Real, key)),
		});
	}, NOW);
	return context;
}

async function settle(page, today) {
	await page.waitForLoadState('networkidle').catch(() => {});
	// Today (and a display) say when they have drawn everything they read.
	if (today)
		await page
			.waitForSelector('[data-testid="today-body"][data-settled="true"]', { timeout: 8000 })
			.catch(() => {});
	await page.addStyleTag({ content: FREEZE });
	await page.evaluate(() => document.fonts.ready).catch(() => {});
	await page.waitForTimeout(500);
}

async function shot(page, name, style, scheme, width) {
	const file = `${name}__${style}-${scheme}-${width}.png`;
	const options = { path: `${out}/${file}`, fullPage: true, animations: 'disabled', caret: 'hide' };
	// A page that has lost its height (a layout that grows without end) cannot be drawn whole, and
	// asking for it can take the browser down: it is taken as the window shows it, and named.
	const height = await page.evaluate(() => document.documentElement.scrollHeight);
	if (height > 16000) {
		const tall = await page.evaluate(() =>
			[...document.querySelectorAll('*')]
				.filter((e) => e.getBoundingClientRect().height > 16000)
				.slice(0, 8)
				.map((e) => `<${e.tagName.toLowerCase()} class="${String(e.className).slice(0, 90)}">`)
				.join(' > '),
		);
		problems.push(`${file}: the page is ${height} px tall; taken as the window shows it. ${tall}`);
		console.log(`TALL ${file} ${height}`);
		options.fullPage = false;
	}
	try {
		await page.screenshot(options);
		count++;
	} catch (error) {
		problems.push(`${file}: ${error.message.split('\n')[0]}`);
		console.log(`FAIL ${file}`);
	}
}

async function runSweep(context, width, scheme, style, pages, goto) {
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.emulateMedia({ colorScheme: scheme === 'night' ? 'dark' : 'light' });
	for (const entry of pages) {
		if (ONLY && !ONLY.includes(entry.name)) continue;
		if (entry.phone && width !== 400) continue;
		errors.length = 0;
		try {
			await goto(page, entry);
			await settle(page, entry.today);
			await entry.prep?.(page);
			await shot(page, entry.name, style, scheme, width);
		} catch (error) {
			problems.push(`${entry.name} ${style}-${scheme}-${width}: ${error.message.split('\n')[0]}`);
			console.log(`FAIL ${entry.name}`);
		}
		for (const message of errors)
			problems.push(`${entry.name} ${style}-${scheme}-${width}: pageerror ${message}`);
	}
	await page.close();
}

// Requests do not use the browser's resolver, so outside Docker they go to this machine directly,
// with the session cookie sent by hand.
const apiBase = env.FAMOS_RESOLVE ? base.replace('host.docker.internal', '127.0.0.1') : base;
const api = (context, cookies, action, data) =>
	context.request.post(`${apiBase}/api/v1/actions/${action}`, {
		headers: {
			origin: base,
			cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
		},
		data,
	});

const admin = await open(serve.cookies, 1440);
const familyPage = (page, { path }) => page.goto(new URL(path, base).href);

// The family pages: Today in each style, the rest in the first style.
for (const style of STYLES) {
	await api(admin, serve.cookies, 'core.setFamilyStyle', { style });
	for (const scheme of ['day', 'night']) {
		for (const width of WIDTHS) {
			const context = await open(serve.cookies, width);
			const pages = style === STYLES[0] ? PAGES : PAGES.filter((p) => p.today);
			await runSweep(context, width, scheme, style, pages, familyPage);
			await context.close();
		}
		console.log(`done ${style} ${scheme}`);
	}
}
await api(admin, serve.cookies, 'core.setFamilyStyle', { style: STYLES[0] });
await admin.close();

// The paired display ("family mode"): no sign-in, no sidebar. Each Today style, day and night.
if (!ONLY || ONLY.includes('display')) {
	const manager = await open(serve.cookies, 1440);
	for (const style of STYLES) {
		await api(manager, serve.cookies, 'core.setDisplayStyle', { deviceId: serve.deviceId, style });
		for (const scheme of ['day', 'night']) {
			for (const width of WIDTHS) {
				const context = await open(serve.displayCookies, width);
				await runSweep(
					context,
					width,
					scheme,
					style,
					[{ name: 'display', path: '/display', today: true }],
					familyPage,
				);
				await context.close();
			}
		}
		console.log(`done display ${style}`);
	}
	await manager.close();
}

await browser.close();
writeFileSync(`${out}/problems.json`, JSON.stringify(problems, null, 2));
console.log(`${count} pictures, ${problems.length} problem(s).`);
for (const line of problems) console.log(`  ${line}`);
