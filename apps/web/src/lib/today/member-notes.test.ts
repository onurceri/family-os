import { describe, expect, it } from 'vitest';
import { MAX_NOTE, mergeMemberNotes, notesRefreshMs } from './member-notes.js';

describe('notes about people', () => {
	it('gives each person shown their note, and nobody else one', () => {
		expect(
			mergeMemberNotes(
				[
					[
						{ memberId: 'alex', text: 'At School' },
						{ memberId: 'sam', text: 'Home' },
						{ memberId: 'archived', text: 'Away' },
					],
				],
				['alex', 'sam', 'deniz'],
			),
		).toEqual({ alex: 'At School', sam: 'Home' });
	});

	it('sets the notes of several facets side by side, in their order, one each', () => {
		expect(
			mergeMemberNotes(
				[
					[
						{ memberId: 'alex', text: 'Away' },
						{ memberId: 'alex', text: 'Home' },
					],
					[{ memberId: 'alex', text: 'at practice' }],
				],
				['alex'],
			),
		).toEqual({ alex: 'Away · at practice' });
	});

	it('leaves out empty words and cuts long ones', () => {
		const notes = mergeMemberNotes(
			[[{ memberId: 'alex', text: '  ' }], [{ memberId: 'sam', text: `At ${'x'.repeat(60)}` }]],
			['alex', 'sam'],
		);
		expect(notes.alex).toBeUndefined();
		expect(notes.sam).toHaveLength(MAX_NOTE);
		expect(notes.sam?.endsWith('…')).toBe(true);
	});

	it('has nothing without facets', () => {
		expect(mergeMemberNotes([], ['alex'])).toEqual({});
	});

	it('reads again as often as the most eager facet asks, but not more than every 15 s', () => {
		expect(notesRefreshMs([])).toBeNull();
		expect(notesRefreshMs([{}, { refreshMs: 60_000 }, { refreshMs: 120_000 }])).toBe(60_000);
		expect(notesRefreshMs([{ refreshMs: 1000 }])).toBe(15_000);
	});
});
