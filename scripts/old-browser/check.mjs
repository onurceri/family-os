// Opens FamilyOS in Chromium 106 (Playwright 1.26) and fails on any script or console error.
// Run it with run.sh, which starts the Playwright 1.26 image; see docs/releasing.md.
//
//   FAMOS_URL     the address of a running FamilyOS, as the container sees it
//   FAMOS_EMAIL / FAMOS_PASSWORD   optional: sign in, then visit the pages below
//   FAMOS_PAGES   optional: comma-separated paths to visit after sign-in
//   FAMOS_OUT     where screenshots go (default ./screenshots)
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const env = process.env;
const url = env.FAMOS_URL;
if (!url) throw new Error('Set FAMOS_URL, for example http://host.docker.internal:3000');
const out = env.FAMOS_OUT ?? 'screenshots';
const signedOut = ['/login', '/display'];
const signedIn = (
	env.FAMOS_PAGES ??
	'/,/calendar,/lists/tasks,/lists/shopping,/board,/kitchen,/assistant,/more,/settings/appearance'
)
	.split(',')
	.map((path) => path.trim())
	.filter(Boolean);

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
console.log(`Chromium ${browser.version()}`);
const failures = [];
// A signed-out page asks who is there and is told 401; plain http is not a trustworthy origin.
const EXPECTED = /status of 401|Cross-Origin-Opener-Policy/;

async function visit(page, path) {
	const errors = [];
	const onError = (error) => errors.push(`pageerror: ${error.message}`);
	const onConsole = (message) => {
		if (message.type() === 'error' && !EXPECTED.test(message.text()))
			errors.push(`console: ${message.text()}`);
	};
	page.on('pageerror', onError);
	page.on('console', onConsole);
	await page.goto(new URL(path, url).href, { waitUntil: 'load' });
	// Long enough for the lazily loaded page and its reads, and for the 6 s the shell may wait.
	await page.waitForLoadState('networkidle').catch(() => {});
	await page.waitForTimeout(2500);
	page.off('pageerror', onError);
	page.off('console', onConsole);
	const name = `${path.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'today'}.png`;
	await page.screenshot({ path: `${out}/${name}` });
	console.log(`${errors.length ? 'FAIL' : 'ok  '} ${path}`);
	for (const error of errors) {
		console.log(`       ${error}`);
		failures.push(`${path}: ${error}`);
	}
}

const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
for (const path of signedOut) await visit(page, path);

if (env.FAMOS_EMAIL && env.FAMOS_PASSWORD) {
	await page.goto(new URL('/login', url).href);
	// Playwright 1.26 has no getByLabel: the form is found by its field types.
	const email = page.locator('input[type=email]');
	if (!(await email.isVisible().catch(() => false)))
		await page
			.locator('button:has-text("Sign in with email")')
			.click({ timeout: 5000 })
			.catch(() => {});
	await email.fill(env.FAMOS_EMAIL);
	await page.locator('input[type=password]').fill(env.FAMOS_PASSWORD);
	await page.locator('button[type=submit]').click();
	await page.waitForTimeout(3000);
	for (const path of signedIn) await visit(page, path);
} else {
	console.log('No FAMOS_EMAIL and FAMOS_PASSWORD: only the signed-out pages were visited.');
}

await browser.close();
if (failures.length) {
	console.log(`\n${failures.length} error(s) in Chromium 106.`);
	process.exit(1);
}
console.log('\nNo errors in Chromium 106.');
