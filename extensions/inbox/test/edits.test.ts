import { describe, expect, it } from 'vitest';
import { approvals, withEdit } from '../src/web/edits.ts';

describe('edits of suggestions in a group', () => {
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
