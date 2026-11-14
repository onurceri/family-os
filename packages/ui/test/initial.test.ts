import { describe, expect, it } from 'vitest';
import { initialOf } from '../src/famos/initial.js';

describe('initialOf', () => {
	it('upper-cases a plain letter', () => {
		expect(initialOf('deniz')).toBe('D');
		expect(initialOf('élodie')).toBe('É');
	});

	it('keeps an emoji whole', () => {
		expect(initialOf('😀 Sam')).toBe('😀');
	});

	it('keeps a flag whole', () => {
		expect(initialOf('🇹🇷 Ayşe')).toBe('🇹🇷');
	});

	it('keeps a joined family emoji whole', () => {
		expect(initialOf('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧');
	});

	it('is empty for an empty or blank name', () => {
		expect(initialOf('')).toBe('');
		expect(initialOf('   ')).toBe('');
	});
});
