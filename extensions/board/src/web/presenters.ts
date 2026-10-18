import { type DraftPresenter, draftDate } from '@famos/ui/slots';
import { StickyNote } from '@lucide/svelte';
import type { PostNoteInput } from '../contract/index.js';

/** A note's first line, which is how a card names it. */
const firstLine = (text: string) => text.trim().split('\n', 1)[0]?.trim() ?? '';

/** A note somebody asked to put on the family board, as its card shows it. */
export const postNotePresenter: DraftPresenter<PostNoteInput> = {
	actionId: 'board.postNote',
	kind: (c) => c.t('board:kind_note'),
	icon: StickyNote,
	title: (input) => firstLine(input.text),
	fields: (input, c) => [
		// The rest of a longer note, so the card never hides words that will be posted.
		...(input.text.trim() !== firstLine(input.text)
			? [{ label: c.t('board:draft_note'), value: input.text.trim(), path: 'text' }]
			: []),
		...(input.endsOn
			? [
					{
						label: c.t('board:draft_until'),
						value: draftDate(input.endsOn, c),
						path: 'endsOn',
					},
				]
			: []),
	],
	approveLabel: (c) => c.t('board:draft_approve_post'),
};
