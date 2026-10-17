import { describe, expect, it } from 'vitest';
import { approvals, choicesAfterEdit, withEdit } from '../src/web/edits.ts';
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
		const edits = withEdit(new Map(), 'draft_2', { title: 'Class 1B trip to Bled' });
		const picked = pickedDrafts(todo, choices);
		expect(approvals(picked, edits)).toEqual([
			{ id: 'draft_1' },
			{ id: 'draft_2', input: { title: 'Class 1B trip to Bled' } },
		]);
		// Taking the edit back leaves the ticks as they were.
		expect(choicesAfterEdit(new Map(), 'draft_2', undefined).size).toBe(0);
	});

	it('approves each ticked suggestion with its edit, and the others as proposed', () => {
		const edits = withEdit(new Map(), 'draft_2', { title: 'Milk 2 l' });
		expect(approvals([{ id: 'draft_1' }, { id: 'draft_2' }], edits)).toEqual([
			{ id: 'draft_1' },
			{ id: 'draft_2', input: { title: 'Milk 2 l' } },
		]);
	});

	it('leaves an unticked suggestion out, edited or not', () => {
		const edits = withEdit(new Map(), 'draft_2', { title: 'Milk 2 l' });
		expect(approvals([{ id: 'draft_1' }], edits)).toEqual([{ id: 'draft_1' }]);
	});

	it('takes an edit back, and does not change the map it was given', () => {
		const first = withEdit(new Map(), 'draft_1', { title: 'A' });
		const second = withEdit(first, 'draft_1', { title: 'B' });
		expect(first.get('draft_1')).toEqual({ title: 'A' });
		expect(second.get('draft_1')).toEqual({ title: 'B' });
		expect(approvals([{ id: 'draft_1' }], withEdit(second, 'draft_1', undefined))).toEqual([
			{ id: 'draft_1' },
		]);
	});
});
