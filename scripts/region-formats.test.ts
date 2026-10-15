import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Dates, times and numbers follow the family's region format, never the UI language alone; and
 * the words in dates and times (day and month names, "PM", "min") follow the reader's language,
 * never the region format alone. This scans the app, the server and every extension for either
 * one handed straight to a formatter: dates and times take a date locale (`dateLocale` from
 * `@famos/time`, `useApp().dateLocale()`), which joins the two.
 */
const root = join(import.meta.dirname, '..');
const dirs = [
	'apps/web/src',
	'apps/server/src',
	'packages/ui/src',
	'packages/core/src',
	...extensionDirs(),
];

function extensionDirs(): string[] {
	return readdirSync(join(root, 'extensions')).map((e) => `extensions/${e}/src`);
}

function* walk(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (/\.(ts|svelte)$/.test(name)) yield path;
	}
}

// The UI language: `app.locale()` in extensions, `getLocale()` in the app.
const LANGUAGE = String.raw`(?:app\.locale\(\)|getLocale\(\)|locale\(\))`;
const FORBIDDEN = [
	new RegExp(
		String.raw`Intl\.(?:DateTimeFormat|NumberFormat|ListFormat|PluralRules)\(\s*${LANGUAGE}`,
	),
	new RegExp(String.raw`\.toLocale\w*String\(\s*${LANGUAGE}`),
	new RegExp(
		String.raw`\b(?:formatDate|formatMinor|formatInput|parseAmount|timeLabel|weekdayNames)\([^)]*${LANGUAGE}`,
	),
];

// The region format by any name: `app.formatLocale()`, `family.formatLocale`, `c.formatLocale` …
const REGION = String.raw`\bformatLocale\b`;
// A call's arguments, one level of parentheses deep, up to the region format.
const ARGS = String.raw`\((?:[^()]|\([^()]*\))*?`;
/** Formatters whose output holds words: they must be given a date locale. */
const WORDS = [
	new RegExp(
		String.raw`Intl\.(?:DateTimeFormat|RelativeTimeFormat|DurationFormat)${ARGS}${REGION}`,
	),
	new RegExp(String.raw`\.toLocale(?:Date|Time)?String${ARGS}${REGION}`),
	new RegExp(
		String.raw`\b(?:formatDate|formatTime|formatClock|weekdayNames|describeRecurrence|describeWhen|timeLabel|dueLabel|monthLabel|rangeLabel|formatDuration|minuteParts|formatPhotoMonth|postedLabel|untilLabel)${ARGS}${REGION}`,
	),
];

function offenders(patterns: readonly RegExp[]): string[] {
	const found: string[] = [];
	for (const dir of dirs) {
		for (const file of walk(join(root, dir))) {
			const text = readFileSync(file, 'utf8');
			for (const re of patterns) {
				if (re.test(text)) found.push(`${file.slice(root.length + 1)} matches ${re.source}`);
			}
		}
	}
	return found;
}

describe('region formats', () => {
	it('never format dates, times or numbers with the UI language', () => {
		expect(offenders(FORBIDDEN)).toEqual([]);
	});

	it('never write the words of dates and times with the region format alone', () => {
		expect(offenders(WORDS)).toEqual([]);
	});

	it('catches the patterns it is looking for', () => {
		expect(FORBIDDEN.some((re) => re.test('new Intl.DateTimeFormat(app.locale(), {})'))).toBe(true);
		expect(FORBIDDEN.some((re) => re.test('new Intl.NumberFormat(getLocale())'))).toBe(true);
		expect(FORBIDDEN.some((re) => re.test('formatDate(day, app.locale())'))).toBe(true);
		expect(FORBIDDEN.some((re) => re.test('new Intl.DateTimeFormat(app.formatLocale(), {})'))).toBe(
			false,
		);
	});

	it('catches the region format handed to a date formatter', () => {
		const caught = (text: string) => WORDS.some((re) => re.test(text));
		expect(caught('new Intl.DateTimeFormat(app.formatLocale(), {})')).toBe(true);
		expect(caught('weekdayNames(app.formatLocale())')).toBe(true);
		expect(caught("formatDate(day, c.formatLocale, { month: 'short' })")).toBe(true);
		expect(caught('formatTime(Number(key), zone, region.formatLocale, cycle)')).toBe(true);
		expect(caught('formatDate(\n\tday,\n\tsettings.formatLocale,\n)')).toBe(true);
		expect(caught('new Intl.DateTimeFormat(app.dateLocale(), {})')).toBe(false);
		expect(caught('new Intl.NumberFormat(app.formatLocale())')).toBe(false);
		expect(caught('formatDate(day, app.dateLocale()); use(formatLocale)')).toBe(false);
	});
});
