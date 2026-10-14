import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import { type FacetWords, type Translate, todayWords } from './today-words.js';

const tr = JSON.parse(
	readFileSync(join(import.meta.dirname, '../../../../languages/tr/app.json'), 'utf8'),
) as Record<string, string>;

/** A catalog lookup with i18next's plural suffixes and `{{placeholders}}`; records the keys. */
function translator(catalog: Record<string, string>, used: Set<string>): Translate {
	return ((key: string, options: Record<string, unknown> = {}) => {
		const plural =
			typeof options.count === 'number' ? `${key}_${options.count === 1 ? 'one' : 'other'}` : key;
		const found = catalog[plural] ?? catalog[key];
		used.add(catalog[plural] !== undefined ? plural : key);
		if (found === undefined) throw new Error(`missing ${key}`);
		return found.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name]));
	}) as unknown as Translate;
}

/** What an extension's facet and block would give (their words are in their own catalogs). */
const extra: FacetWords = {
	counts: {
		title: 'Chores today',
		label: 'Chores',
		ring: (name, done, total) => `${name}: ${done} of ${total} done`,
		left: (count) => `${count} left`,
	},
	meals: 'Kitchen',
};

/** Calls every function in the words so each key is looked up. */
function exercise(words: ReturnType<typeof todayWords>) {
	const { nextUp, status, day } = words;
	return [
		nextUp.countdown.inDuration('25 minutes'),
		nextUp.countdown.nowUntil('16:30'),
		nextUp.pill.at('Music school'),
		nextUp.pill.starts('15:45'),
		nextUp.pill.until('16:30'),
		status.soon('Piano lesson', '25 min'),
		status.at('Football', '17:00'),
		status.until('Piano lesson', '16:30'),
		status.choresLeft(1),
		status.choresLeft(3),
		day.more(2),
		day.followedBy('Football 17:00'),
		words.nothingFor('Deniz and Amy'),
		words.choreRing('Elif', 1, 3),
		words.photo('October 2025'),
		words.noneForMe,
		words.nextUpError,
		words.restOfDay,
		words.choresToday,
		words.kitchen,
		words.whoNext,
		words.names(['Deniz', 'Amy', 'Elif']),
	];
}

describe('Today words', () => {
	it('reads every today_ key of the English catalog, and Turkish has them all', () => {
		const used = new Set<string>();
		const words = todayWords(translator(en, used), extra);
		const english = exercise(words);
		expect(english).toContain('Piano lesson in 25 min');
		expect(english).toContain('3 left');
		expect(english).toContain('Elif: 1 of 3 done');
		expect(english).toContain('From the photos · October 2025');
		expect(english).toContain('Deniz, Amy and Elif');
		expect(words.nextUp.nextUp).toBe('Next up');

		const todayKeys = Object.keys(en).filter((k) => k.startsWith('today_'));
		expect([...used].sort()).toEqual(todayKeys.sort());
		for (const key of todayKeys) expect(tr[key], key).toBeTruthy();
		expect(exercise(todayWords(translator(tr, new Set()), extra))).toContain(
			'Fotoğraflardan · October 2025',
		);
	});
});
