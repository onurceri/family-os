import { describe, expect, it } from 'vitest';
import { choicesAfterEdit } from '../src/web/edits.ts';
import { pickedDrafts } from '../src/web/item-view.ts';

describe('edits of suggestions in a group', () => {
	// Found in use: an edit saved on a suggestion that may already exist did not tick it, so
	// "Add selected" said "Added" and left the edited event waiting with what it first proposed.
	it('ticks a card whose edit is saved, also one that started unticked', () => {
		const todo = [
			{ id: 'draft_1', instead: null, mayExist: false as const },
			{ id: 'draft_2', instead: null, mayExist: true as const },
		];
		expect(pickedDrafts(todo, new Map()).map((d) => d.id)).toEqual(['draft_1']);
		const choices = choicesAfterEdit(new Map(), 'draft_2', { title: 'Class 1B trip to Bled' });
		expect(pickedDrafts(todo, choices).map((d) => d.id)).toEqual(['draft_1', 'draft_2']);
		// Taking the edit back leaves the ticks as they were.
		expect(choicesAfterEdit(new Map(), 'draft_2', undefined).size).toBe(0);
	});

	it('does not change the ticks it was given', () => {
		const choices = new Map([['draft_1', false]]);
		const next = choicesAfterEdit(choices, 'draft_2', { title: 'A' });
		expect(choices.size).toBe(1);
		expect(next.get('draft_2')).toBe(true);
		expect(next.get('draft_1')).toBe(false);
	});
});
