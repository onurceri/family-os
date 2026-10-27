// Checks, color by color, that a browser without `color-mix()` (Chrome before 111) shows what a
// modern one does. Every `{ mix, fallback }` pair is evaluated under the built-in tokens and under
// each bundled theme pack, day and night: the mix in the repo's Chromium, the fallback in both it
// and Chromium 106 (Docker, Playwright 1.26). The difference is ΔEOK (OKLab distance times 100;
// about 2 is the smallest a person notices). Prints a table, worst first; exits 1 when a pair
// exceeds the threshold or a fallback does not parse in Chromium 106. See docs/releasing.md.
//
//   node scripts/old-browser/colors.mjs [pairs.json]    (default colors.sample.json)
//
// pairs.json is `[{ "file": "…", "selector": "…" (optional), "mix": "color-mix(…)", "fallback": "…" }]`.
//   FAMOS_COLORS_MAX    threshold in ΔEOK (default 2)
//   FAMOS_COLORS_ALL=1  list every pair, not only those over the threshold and the 15 worst
//
// The same file measures inside a browser (FAMOS_COLORS_MEASURE=1, run by itself in Docker) and
// uses only calls Playwright 1.26 and the repo's version share.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Playwright from the repo's root on the host (a stray copy of 1.26 next to these scripts would
 * otherwise win); in Docker the script is copied alone, next to the 1.26 it installs.
 */
function loadPlaywright() {
	try {
		return createRequire(new URL('../../package.json', import.meta.url))('playwright-core');
	} catch {
		return createRequire(import.meta.url)('playwright-core');
	}
}
const { chromium } = loadPlaywright();

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const env = process.env;

/**
 * In the browser: for each sheet, each mode and each pair, the computed color of the mix and of
 * the fallback (null when the browser does not accept the value or it does not resolve).
 */
async function measure(browser, payload) {
	const page = await browser.newPage();
	const results = [];
	for (const sheet of payload.sheets) {
		await page.setContent(
			`<!doctype html><html><head><style>${sheet.css}</style></head><body><div><span id="t">x</span></div></body></html>`,
		);
		for (const mode of ['day', 'night']) {
			const computed = await page.evaluate(
				({ mode, pairs }) => {
					document.documentElement.classList.toggle('dark', mode === 'night');
					const el = document.getElementById('t');
					const wrapper = el.parentElement;
					// A value the browser rejects, or one that does not resolve (an unset variable),
					// leaves the color the element inherits. So the value is read under two parent
					// colors: when the answer follows the parent, it is not the value's own.
					const parents = ['rgb(11, 22, 33)', 'rgb(44, 55, 66)'];
					const under = (value, parent) => {
						wrapper.style.color = parent;
						el.style.color = '';
						el.style.color = value;
						return getComputedStyle(el).color;
					};
					const read = (value) => {
						const [a, b] = parents.map((parent) => under(value, parent));
						return a === parents[0] && b === parents[1] && !/currentcolor/i.test(value) ? null : a;
					};
					return pairs.map((pair) => ({ mix: read(pair.mix), fallback: read(pair.fallback) }));
				},
				{ mode, pairs: payload.pairs },
			);
			results.push({ sheet: sheet.name, mode, computed });
		}
	}
	await page.close();
	return results;
}

if (env.FAMOS_COLORS_MEASURE) {
	// Inside the container: read the payload, write what this browser computes.
	const payload = JSON.parse(readFileSync(env.FAMOS_COLORS_IN, 'utf8'));
	const browser = await chromium.launch();
	const version = browser.version();
	const results = await measure(browser, payload);
	await browser.close();
	writeFileSync(env.FAMOS_COLORS_OUT, JSON.stringify({ version, results }));
	process.exit(0);
}

// ---- The host: sheets, both browsers, the comparison ------------------------------------------

const { readThemeDirSync, listThemeDirsSync } = await import('../../packages/themes/src/node.ts');
const { renderStylesheet, validateThemePack } = await import('../../packages/themes/src/index.ts');

const input = resolve(process.argv[2] ?? join(here, 'colors.sample.json'));
const threshold = Number(env.FAMOS_COLORS_MAX ?? 2);
const entries = JSON.parse(readFileSync(input, 'utf8'));

// One pair per distinct mix and fallback; where it was found is kept for the table.
const distinct = new Map();
for (const e of entries) {
	const key = `${e.mix}\u0000${e.fallback}`;
	const found = distinct.get(key) ?? { mix: e.mix, fallback: e.fallback, where: [] };
	found.where.push(`${e.file}${e.selector ? ` ${e.selector}` : ''}`);
	distinct.set(key, found);
}
const pairs = [...distinct.values()];

// The built app's stylesheets hold the default tokens (`:root`, `.dark`).
const assets = join(root, 'apps/web/build/_app/immutable/assets');
let builtCss;
try {
	builtCss = readdirSync(assets)
		.filter((f) => f.endsWith('.css'))
		.map((f) => readFileSync(join(assets, f), 'utf8'))
		.join('\n');
} catch {
	console.error('Build first: pnpm build (apps/web/build is missing)');
	process.exit(2);
}

const sheets = [{ name: 'built-in', css: builtCss }];
const themesDir = join(root, 'themes');
const base = validateThemePack(readThemeDirSync(join(themesDir, 'ev-isigi')));
if (!base.ok) throw new Error(`ev-isigi is invalid: ${base.errors.join('; ')}`);
for (const id of listThemeDirsSync(themesDir).sort()) {
	const result = validateThemePack(readThemeDirSync(join(themesDir, id)), {
		fallback: base.pack.tokens,
	});
	if (!result.ok) throw new Error(`${id} is invalid: ${result.errors.join('; ')}`);
	sheets.push({
		name: id,
		css: `${builtCss}\n${renderStylesheet(result.pack, () => '', { channels: true })}`,
	});
}

const work = mkdtempSync(join(tmpdir(), 'famos-colors-'));
const payload = { sheets, pairs: pairs.map(({ mix, fallback }) => ({ mix, fallback })) };
writeFileSync(join(work, 'payload.json'), JSON.stringify(payload));

const modernBrowser = await chromium.launch();
const modern = { version: modernBrowser.version(), results: await measure(modernBrowser, payload) };
await modernBrowser.close();

mkdirSync(join(work, 'out'));
const docker = spawnSync(
	'docker',
	[
		'run',
		'--rm',
		'-e',
		'FAMOS_COLORS_MEASURE=1',
		'-e',
		'FAMOS_COLORS_IN=/in/payload.json',
		'-e',
		'FAMOS_COLORS_OUT=/out/old.json',
		'-v',
		`${here}:/src:ro`,
		'-v',
		`${work}:/in:ro`,
		'-v',
		`${join(work, 'out')}:/out`,
		'mcr.microsoft.com/playwright:v1.26.0-focal',
		'bash',
		'-c',
		'mkdir -p /w && cp /src/colors.mjs /w/ && cd /w && npm i --silent --no-save --no-package-lock playwright-core@1.26.0 >/dev/null 2>&1; node colors.mjs',
	],
	{ stdio: ['ignore', 'inherit', 'inherit'] },
);
if (docker.status !== 0) {
	console.error('Chromium 106 did not run (is Docker running?).');
	process.exit(2);
}
const old = JSON.parse(readFileSync(join(work, 'out/old.json'), 'utf8'));
console.log(
	`Modern ${modern.version}, old ${old.version}; ${pairs.length} pairs; threshold ΔEOK ${threshold}\n`,
);

// ---- Colors and ΔE ---------------------------------------------------------------------------

const num = (text) => {
	if (text === 'none') return 0;
	return text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text);
};

/** A computed color (`rgb()`, `color(srgb …)`, `oklab()`, `oklch()`) as linear sRGB and alpha. */
function parse(text) {
	const m = /^([a-z-]+)\((.*)\)$/.exec(text.trim());
	if (!m) return null;
	const [body, alphaText] = m[2].split('/').map((s) => s.trim());
	const parts = body.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
	let alpha = alphaText === undefined ? 1 : num(alphaText);
	const srgb = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	let linear;
	if (m[1] === 'rgb' || m[1] === 'rgba') {
		if (parts.length === 4) alpha = num(parts[3]);
		linear = parts.slice(0, 3).map((p) => srgb(num(p) / (p.endsWith('%') ? 1 : 255)));
	} else if (m[1] === 'color' && parts[0] === 'srgb') {
		linear = parts.slice(1, 4).map((p) => srgb(num(p)));
	} else if (m[1] === 'oklab' || m[1] === 'oklch') {
		const L = num(parts[0]);
		let a = num(parts[1]);
		let b = num(parts[2]);
		if (m[1] === 'oklch') {
			const c = a;
			const h = (b * Math.PI) / 180;
			a = c * Math.cos(h);
			b = c * Math.sin(h);
		}
		const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
		const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
		const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
		linear = [
			4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
			-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
			-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
		];
	} else return null;
	return { linear: linear.map((v) => Math.min(1, Math.max(0, v))), alpha };
}

/** OKLab of a color laid over a flat gray level (0 black to 1 white). */
function oklabOver({ linear, alpha }, backdrop) {
	const [r, g, b] = linear.map((v) => v * alpha + backdrop * (1 - alpha));
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

/** ΔEOK: the larger of the distances over white and over black (a see-through color is judged on both). */
function deltaE(a, b) {
	return Math.max(
		...[0, 1].map((backdrop) => {
			const x = oklabOver(a, backdrop);
			const y = oklabOver(b, backdrop);
			return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
		}),
	);
}

const rows = [];
const failures = [];
const skipped = [];
for (const [index, found] of modern.results.entries()) {
	const oldRun = old.results[index];
	for (const [i, pair] of pairs.entries()) {
		const mix = found.computed[i].mix;
		const fallbackModern = found.computed[i].fallback;
		const fallbackOld = oldRun.computed[i].fallback;
		const label = `${found.sheet} ${found.mode}`;
		if (mix === null) {
			skipped.push({ label, pair, why: 'the mix does not resolve here (unset variable?)' });
			continue;
		}
		if (fallbackOld === null) {
			failures.push({ label, pair, why: 'the fallback does not parse in Chromium 106' });
			continue;
		}
		const a = parse(mix);
		const b = parse(fallbackOld);
		if (!a || !b) {
			failures.push({
				label,
				pair,
				why: `cannot read the computed color (${a ? fallbackOld : mix})`,
			});
			continue;
		}
		rows.push({ de: deltaE(a, b), label, pair, mix, fallbackOld, fallbackModern });
	}
}
rows.sort((x, y) => y.de - x.de);

const over = rows.filter((r) => r.de > threshold);
const shown = env.FAMOS_COLORS_ALL ? rows : rows.slice(0, Math.max(15, over.length));
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
console.log('ΔEOK  theme/mode              mix → 106 fallback');
for (const r of shown)
	console.log(
		`${r.de.toFixed(2).padStart(5)} ${r.de > threshold ? '!' : ' '} ${r.label.padEnd(22)} ${cut(r.pair.mix, 60)}\n${' '.repeat(32)}${r.mix} → ${r.fallbackOld}\n${' '.repeat(32)}${cut(r.pair.where[0], 70)}`,
	);
if (rows.length > shown.length)
	console.log(`… ${rows.length - shown.length} more within the threshold`);
for (const f of failures)
	console.log(
		`FAIL  ${f.label}: ${cut(f.pair.fallback, 70)}: ${f.why}\n${' '.repeat(6)}${cut(f.pair.where[0], 70)}`,
	);
for (const s of skipped.slice(0, 5))
	console.log(`skip  ${s.label}: ${cut(s.pair.mix, 70)}: ${s.why}`);
if (skipped.length > 5) console.log(`skip  … ${skipped.length - 5} more`);
console.log(
	`\n${rows.length} compared, ${over.length} over ΔEOK ${threshold}, ${failures.length} unparseable, ${skipped.length} skipped. Worst ${rows[0] ? rows[0].de.toFixed(2) : '-'}.`,
);
process.exit(over.length || failures.length ? 1 : 0);
