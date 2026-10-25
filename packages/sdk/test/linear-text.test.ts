import { describe, expect, it } from 'vitest';
import { compareThing, significantWords, withoutAmounts } from '../src/index.ts';
import { withoutBrackets } from '../src/label-words.ts';

/** A seeded random text over `alphabet`, so a failure can be replayed. */
function texts(alphabet: readonly string[], count: number, seed = 7): string[] {
	let state = seed;
	const next = () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
	return Array.from({ length: count }, () =>
		Array.from(
			{ length: Math.floor(next() * 24) },
			() => alphabet[Math.floor(next() * alphabet.length)],
		).join(''),
	);
}

/** The regular expressions these helpers replaced, as the reference for normal text. */
const bracketsBefore = (text: string) => text.replace(/\([^)]*\)|\[[^\]]*\]/gu, ' ');
const MONEY = /\p{Sc}|\d[.,]\d{2}(?!\d)|\d\s?[A-Z]{3}(?![\p{L}\p{N}])/u;
const amountsBefore = (notes: string) =>
	notes
		.split(/(?<=[.;]\s+|\n)(?=\S)/u)
		.filter((part) => !MONEY.test(part))
		.join('')
		.replace(/[\s;]+$/u, '')
		.trim();

const quickly = (run: () => unknown) => {
	const started = Date.now();
	run();
	expect(Date.now() - started).toBeLessThan(500);
};

const LONG = 200_000;

describe('withoutBrackets', () => {
	it('gives what the bracket pattern gave', () => {
		expect(withoutBrackets('Milk (2 l) [fridge] (open')).toBe('Milk     (open');
		for (const text of texts(['(', ')', '[', ']', 'a', '1', ' ', '\n'], 5000))
			expect(withoutBrackets(text)).toBe(bracketsBefore(text));
	});

	it('takes one pass over many brackets left open', () => {
		quickly(() => withoutBrackets('('.repeat(LONG)));
		quickly(() => withoutBrackets('['.repeat(LONG)));
		quickly(() => significantWords(`${'('.repeat(LONG)}${'['.repeat(LONG)} milk`));
		quickly(() => compareThing(`${'('.repeat(LONG)} milk`, 'Milk'));
	});
});

describe('withoutAmounts', () => {
	it('gives what the sentence pattern gave', () => {
		const alphabet = ['a', 'B', '.', ';', ' ', '\t', '\n', '1', '5', ',', '€', 'EUR', '00'];
		for (const text of texts(alphabet, 5000))
			expect(withoutAmounts(text)).toBe(amountsBefore(text));
	});

	it('takes one pass over long runs of spaces', () => {
		quickly(() => withoutAmounts(`${'\t'.repeat(LONG)}x`));
		quickly(() => withoutAmounts(`a.${' '.repeat(LONG)}x`));
		quickly(() => withoutAmounts(`${'; '.repeat(LONG)}x`));
	});
});
