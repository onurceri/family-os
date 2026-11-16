import { describe, expect, it } from 'vitest';
import { showNoPhotosNote } from '../src/web/slideshow-note.js';

describe('the note under a family device photo switch', () => {
	it('shows only when the library was read and is empty', () => {
		expect(showNoPhotosNote(0)).toBe(true);
		expect(showNoPhotosNote(3)).toBe(false);
		expect(showNoPhotosNote(null)).toBe(false);
	});
});
