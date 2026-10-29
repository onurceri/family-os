import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Themes only work when everything is styled through tokens. This scans the web app,
 * `@famos/ui` and the extensions for colors written into the code (hex, rgb(), hsl(), oklch(),
 * Tailwind palette classes, white and black) outside the token layer (`theme.css`).
 */
const root = join(import.meta.dirname, '..');
const dirs = ['apps/web/src', 'packages/ui/src', 'extensions'];
const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'build',
	'.svelte-kit',
	'.turbo',
	'generated',
	'test',
	'tests',
	'messages',
]);
const EXTENSIONS = /\.(svelte|ts|css|html)$/;

/** Files that may name colors, and why. Anything else must use a token. */
const ALLOWED: Record<string, string> = {
	'packages/ui/src/theme.css': 'the token layer itself (the built-in Ev Işığı values)',
	'apps/web/src/app.html': 'the theme-color meta and the loading mark before the theme is applied',
	'apps/web/src/lib/today/sample-people.ts':
		"the made-up people of the style previews: a person's color is data (core's member colors), not interface styling",
	'extensions/calendar/src/contract/index.ts':
		'the colors people pick for calendars: data they choose, not interface styling',
	'packages/ui/src/colors.ts':
		'writes the rgb() an older browser computes for a color mix: arithmetic over the theme tokens, no colors of its own',
	'packages/ui/src/famos/resize.ts':
		'flattens a transparent photo onto white when making a JPEG: image processing, not styling',
};

const PALETTE =
	'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';
const PREFIX =
	'text|bg|border|ring|fill|stroke|from|to|via|outline|decoration|divide|shadow|accent|caret';
const NAMED =
	'white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon';

const FORBIDDEN: { re: RegExp; why: string }[] = [
	{ re: /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b/, why: 'a hex color' },
	{ re: /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/, why: 'a color function' },
	{
		re: new RegExp(`\\b(?:${PREFIX})-(?:${PALETTE})-\\d{2,3}\\b`),
		why: 'a Tailwind palette color',
	},
	{
		re: /\b(?:bg|text|border|fill|stroke|ring|outline|from|to|via)-(?:white|black)\b/,
		why: 'white or black',
	},
	{
		re: new RegExp(
			`\\b(?:color|background(?:-color)?|fill|stroke|border-color)\\s*[:=]\\s*['"]?(?:${NAMED})\\b`,
			'i',
		),
		why: 'a named color',
	},
	{
		re: /style:(?:color|background-color|fill|stroke)=["']\s*(?:white|black)/,
		why: 'a named color',
	},
];

function* walk(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (EXTENSIONS.test(name) && !/\.(test|spec)\.ts$/.test(name)) yield path;
	}
}

describe('no hard-coded colors outside the token layer', () => {
	it('uses tokens everywhere', () => {
		const offenders: string[] = [];
		for (const dir of dirs) {
			for (const file of walk(join(root, dir))) {
				const relative = file.slice(root.length + 1);
				if (relative in ALLOWED) continue;
				const lines = readFileSync(file, 'utf8').split('\n');
				lines.forEach((line, index) => {
					for (const { re, why } of FORBIDDEN) {
						const match = re.exec(line);
						if (match) offenders.push(`${relative}:${index + 1}: ${why} (${match[0]})`);
					}
				});
			}
		}
		expect(offenders).toEqual([]);
	});

	it('only allows files that exist and still need the exception', () => {
		for (const file of Object.keys(ALLOWED)) {
			const text = readFileSync(join(root, file), 'utf8');
			expect(
				FORBIDDEN.some(({ re }) => text.split('\n').some((line) => re.test(line))),
				`${file} no longer names a color: remove it from the allow-list`,
			).toBe(true);
		}
	});

	it('catches the patterns it is looking for', () => {
		const hits = (source: string) => FORBIDDEN.some(({ re }) => re.test(source));
		expect(hits('<p class="text-red-500">')).toBe(true);
		expect(hits('<div class="bg-white p-2">')).toBe(true);
		expect(hits('<div class="border-black">')).toBe(true);
		expect(hits('const c = "#ff0000"')).toBe(true);
		expect(hits('const c = "#fff"')).toBe(true);
		expect(hits('style="color: white"')).toBe(true);
		expect(hits('style="background: rgb(1 2 3)"')).toBe(true);
		expect(hits('background-color: oklch(0.5 0.1 20)')).toBe(true);
		expect(hits('<p class="text-ink-soft bg-surface">')).toBe(false);
		expect(hits('<p class="bg-attention text-on-color">')).toBe(false);
		expect(hits('<a href="#main">')).toBe(false);
		expect(hits('fill="currentColor"')).toBe(false);
	});
});
