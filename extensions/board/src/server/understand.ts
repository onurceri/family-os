import { defineMentionKind, type Resolution, refuse, sameText } from '@famos/sdk';
import { compareDates } from '@famos/time';
import { tables } from './store.ts';

export const noteKind = defineMentionKind({
	id: 'board.note',
	describe:
		'A note for the family board, where everyone sees it: only when the person asks for something to be put up for the whole family ("put it on the board", "let everyone know"). Not for an event, a task or something to buy.',
	slots: {
		notes: 'The note, written as the person would, in their language',
		endDate: 'The last day it matters, when the message says ("until Friday")',
	},
	actions: ['board.postNote'],
	limit: 3,
	examples: [
		{
			text: 'Put on the board: the plumber comes Thursday morning, keep the kitchen clear until then',
			mentions: [
				{
					kind: 'board.note',
					quote: 'the plumber comes Thursday morning, keep the kitchen clear until then',
					notes: 'The plumber comes Thursday morning: keep the kitchen clear until then',
					endDate: { text: 'Thursday', weekday: 4 },
				},
			],
		},
	],
	decides: {},
	async resolve(ctx, mentions) {
		const now = ctx.now;
		const onBoard = await tables(ctx.db)
			.selectFrom('board_notes')
			.select('text')
			.where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]))
			.execute();
		return mentions.map(({ index, mention }): Resolution => {
			const text = mention.notes ?? mention.title;
			if (!text) return refuse('incomplete', null, index);
			if (onBoard.some((n) => sameText(n.text, text))) return refuse('already', text, index);
			const ends = ctx.day(mention.endDate, 'future');
			// A last day that has passed would hide the note at once.
			const endsOn = ends && compareDates(ends.date, ctx.today) >= 0 ? ends : null;
			return {
				propose: {
					actionId: 'board.postNote',
					input: { text, ...(endsOn && { endsOn: endsOn.date }) },
					subject: text,
					uncertain: endsOn && !endsOn.certain ? ['endsOn'] : [],
					from: [index],
				},
			};
		});
	},
});
