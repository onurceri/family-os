import { describe, expect, it } from 'vitest';
import { menuSide } from '../src/famos/menu-place.js';

const at = (left: number, right: number) => ({ left, right });

describe('menuSide', () => {
	it('keeps the side the caller asked for while the menu fits', () => {
		expect(
			menuSide({ anchor: at(300, 336), width: 220, viewport: 400, preferred: 'end', dir: 'ltr' }),
		).toBe('end');
		expect(
			menuSide({ anchor: at(20, 56), width: 220, viewport: 400, preferred: 'start', dir: 'ltr' }),
		).toBe('start');
	});

	it('opens toward the middle when its own side would run off the left edge', () => {
		// A note in the left column of a phone: the button sits about 150 px from the left.
		expect(
			menuSide({ anchor: at(140, 184), width: 220, viewport: 400, preferred: 'end', dir: 'ltr' }),
		).toBe('start');
	});

	it('opens toward the middle when its own side would run off the right edge', () => {
		expect(
			menuSide({ anchor: at(340, 376), width: 220, viewport: 400, preferred: 'start', dir: 'ltr' }),
		).toBe('end');
	});

	it('reads start and end in the text direction', () => {
		// In rtl `end` lines the menu up with the button's left edge.
		expect(
			menuSide({ anchor: at(20, 56), width: 220, viewport: 400, preferred: 'end', dir: 'rtl' }),
		).toBe('end');
		expect(
			menuSide({ anchor: at(340, 376), width: 220, viewport: 400, preferred: 'end', dir: 'rtl' }),
		).toBe('start');
	});

	it('keeps the side that hides less when neither fits', () => {
		expect(
			menuSide({ anchor: at(60, 96), width: 380, viewport: 400, preferred: 'end', dir: 'ltr' }),
		).toBe('start');
		expect(
			menuSide({ anchor: at(300, 336), width: 380, viewport: 400, preferred: 'start', dir: 'ltr' }),
		).toBe('end');
	});
});
