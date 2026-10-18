import { describe, expect, it } from 'vitest';
import { addressesEveryone } from '../src/mention-kinds.ts';

const WORDS = ['everyone', 'the whole family', 'all of us'];

describe('addressesEveryone', () => {
	it('finds whole words and phrases, case aside', () => {
		expect(addressesEveryone('Dinner for Everyone!', WORDS, 'en')).toBe(true);
		expect(addressesEveryone('It is for the whole  family.', WORDS, 'en')).toBe(true);
	});

	it('does not find part of a word, a part of a phrase, or anything without text', () => {
		expect(addressesEveryone('everyones coat', WORDS, 'en')).toBe(false);
		expect(addressesEveryone('the whole thing', WORDS, 'en')).toBe(false);
		expect(addressesEveryone(null, WORDS, 'en')).toBe(false);
		expect(addressesEveryone('hello', [], 'en')).toBe(false);
	});
});
