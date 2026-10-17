import { findTarget } from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import { isObligationOf, obligationContextLabel, pickRecord } from '../src/contract/index.ts';

const CLIO = { id: 'v1', label: 'Clio' };
const GOLF = { id: 'v2', label: 'Golf' };
const reading = (text: string | null) => ({
	text,
	target: <T extends { label: string }>(words: string | undefined, candidates: readonly T[]) =>
		findTarget(words, candidates, { text }),
});

describe('which record a mention is about', () => {
	it('takes the one the words and the message name', () => {
		expect(pickRecord(reading('Oil change for the Golf'), 'Golf', [CLIO, GOLF])).toEqual({
			found: GOLF,
			certain: true,
		});
	});

	it('takes a listed name the message does not write as a guess, but never one it contradicts', () => {
		expect(pickRecord(reading('New tyres on the car'), 'Clio', [CLIO, GOLF])).toEqual({
			found: CLIO,
			certain: false,
		});
		expect(pickRecord(reading('New tyres on the Golf'), 'Clio', [CLIO, GOLF])).toEqual({
			refuse: 'ambiguous',
		});
	});

	it('refuses a name that is not listed instead of picking another', () => {
		expect(pickRecord(reading('Rex had a check-up'), 'Rex', [CLIO])).toEqual({ refuse: 'unknown' });
		expect(pickRecord(reading('Rex had a check-up'), 'Rex', [])).toEqual({ refuse: 'unknown' });
	});

	it('without words, takes the only record or the one the message names', () => {
		expect(pickRecord(reading('A car wash'), undefined, [CLIO])).toEqual({
			found: CLIO,
			certain: false,
		});
		expect(pickRecord(reading('The Clio got washed'), undefined, [CLIO, GOLF])).toEqual({
			found: CLIO,
			certain: true,
		});
		expect(pickRecord(reading('A car wash'), undefined, [CLIO, GOLF])).toEqual({
			refuse: 'ambiguous',
		});
	});

	it('trusts the words alone when files were read', () => {
		expect(pickRecord(reading(null), 'golf', [CLIO, GOLF])).toEqual({ found: GOLF, certain: true });
	});
});

it('tells an obligation of a record from the way records lists it', () => {
	const label = obligationContextLabel('Rabies', 'Mia');
	expect(label).toBe('Rabies (Mia)');
	expect(isObligationOf(label, 'Mia')).toBe(true);
	expect(isObligationOf(label, 'Max')).toBe(false);
});
