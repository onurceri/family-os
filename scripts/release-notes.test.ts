import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS script without type declarations
import { parseCommit, parseCorrection, renderNotes } from './release-notes.mjs';

describe('release notes', () => {
	it('parses Conventional Commits, including breaking changes', () => {
		expect(parseCommit('feat(lists): shopping categories\n\nBody')).toMatchObject({
			type: 'feat',
			scope: 'lists',
			subject: 'shopping categories',
			breaking: false,
		});
		expect(parseCommit('feat!: new backup format')).toMatchObject({ breaking: true });
		expect(parseCommit('fix(core): x\n\nBREAKING CHANGE: restore needs 0.3 backups')).toMatchObject(
			{ breaking: true, breakingNote: 'restore needs 0.3 backups' },
		);
		expect(parseCommit('Merge branch main')).toBeNull();
	});

	it('groups user-visible changes and leaves out maintenance', () => {
		const notes = renderNotes(
			'0.2.0',
			[
				'feat(inbox): share photos',
				'fix(security): lock PINs after five failures',
				'fix: calendar shows all-day events',
				'feat!: roles replace parent/child\n\nBREAKING CHANGE: members become supervised',
				'docs: user guide',
				'test(e2e): more tests',
				'chore(release): 0.1.0',
			],
			new Date('2026-10-07T12:00:00Z'),
		);
		expect(notes).toBe(
			[
				'## 0.2.0 (2026-10-07)',
				'',
				'### Breaking changes',
				'',
				'- roles replace parent/child — members become supervised',
				'',
				'### New',
				'',
				'- **inbox:** share photos',
				'',
				'### Fixed',
				'',
				'- calendar shows all-day events',
				'',
				'### Security',
				'',
				'- lock PINs after five failures',
				'',
			].join('\n'),
		);
		expect(renderNotes('0.2.1', ['docs: typo'])).toContain('Maintenance only');
	});

	it("lets a later commit correct or drop an earlier commit's line", () => {
		const date = new Date('2026-10-07T12:00:00Z');
		const sha = (c: string) => c.repeat(40);
		const entries = [
			{
				sha: sha('9'),
				message:
					'chore: moves a line\n\nRelease-note-for: fffffff\nRelease-note: fix(board): now a fix',
			},
			{ sha: sha('f'), message: 'feat(board): untouched until corrected' },
			{
				sha: sha('c'),
				message:
					'chore(release): newest correction\n\nRelease-note-for: aaaaaaa\nRelease-note: fix(inbox): right text',
			},
			{
				sha: sha('d'),
				message:
					'chore: older correction\n\nRelease-note-for: aaaaaaa\nRelease-note: fix(inbox): stale text',
			},
			{
				sha: sha('e'),
				message: 'docs: drops a line\n\nRelease-note-for: bbbbbbb\nRelease-note: none',
			},
			{ sha: sha('b'), message: 'feat(lists): drop me' },
			{ sha: sha('a'), message: 'fix(inbox): wrong claim (#23)' },
			{ sha: sha('1'), message: 'feat(kitchen): left alone' },
		];
		expect(parseCorrection('fix: x')).toBeNull();
		expect(renderNotes('0.2.0', entries, date)).toBe(
			[
				'## 0.2.0 (2026-10-07)',
				'',
				'### New',
				'',
				'- **kitchen:** left alone',
				'',
				'### Fixed',
				'',
				'- **board:** now a fix',
				'- **inbox:** right text',
				'',
			].join('\n'),
		);
	});

	it('marks the first release, with or without user-visible commits', () => {
		const date = new Date('2026-10-07T12:00:00Z');
		expect(renderNotes('0.1.0', ['Initial commit'], date, { first: true })).toBe(
			['## 0.1.0 (2026-10-07)', '', 'First release.', ''].join('\n'),
		);
		expect(
			renderNotes('0.1.0', ['feat: shared calendar', 'chore(release): 0.1.0'], date, {
				first: true,
			}),
		).toBe(
			[
				'## 0.1.0 (2026-10-07)',
				'',
				'First release.',
				'',
				'### New',
				'',
				'- shared calendar',
				'',
			].join('\n'),
		);
	});
});
