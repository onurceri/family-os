import type { IndexedMention, Mention } from '@famos/sdk';
import { describe, expect, it } from 'vitest';
import {
	detailLine,
	FOLDED_NOTES_MAX,
	foldDetails,
	keepsDetail,
} from '../src/server/understand/fold.ts';
import { placeReading } from '../src/server/understand/pipeline.ts';

const at = (index: number, mention: Mention): IndexedMention => ({ index, mention });
const notesKinds = new Set(['calendar.event', 'lists.task', 'board.note']);
const takesNotes = (kind: string) => notesKinds.has(kind);
const fold = (mentions: IndexedMention[]) => foldDetails(mentions, takesNotes, 'en');

const recital = at(0, {
	kind: 'calendar.event',
	title: 'Piano recital',
	date: { text: 'Sat 14 Nov', day: 14, month: 11, weekday: 6 },
	time: '15:00',
	place: 'Music school',
});

describe('foldDetails', () => {
	it('puts a rule and a thing to bring into the notes of the event they belong to', () => {
		const out = fold([
			recital,
			at(1, { kind: 'board.note', notes: 'No phones in the hall', of: 0, relation: 'rule' }),
			at(2, { kind: 'lists.task', title: 'Bring blue music book', of: 0, relation: 'bring' }),
		]);
		expect(out.mentions).toEqual([
			at(0, { ...recital.mention, notes: 'No phones in the hall\nBring blue music book' }),
		]);
		expect(out.details.get(0)?.map((d) => d.index)).toEqual([1, 2]);
	});

	it('keeps a detail with a day or a person of its own as a suggestion of its own', () => {
		const fee = at(1, {
			kind: 'lists.task',
			title: 'Pay 10 EUR for the bus',
			date: { text: 'Fri', weekday: 5 },
			of: 0,
		});
		const forIvy = at(2, { kind: 'lists.task', title: 'Bring the kit', people: ['Ivy'], of: 0 });
		const mine = at(3, { kind: 'lists.task', title: 'Pack the bag', forMe: true, of: 0 });
		const daily = at(4, { kind: 'lists.task', title: 'Practise', repeat: { every: 'day' }, of: 0 });
		const out = fold([recital, fee, forIvy, mine, daily]);
		expect(out.mentions).toEqual([recital, fee, forIvy, mine, daily]);
		expect(out.details.size).toBe(0);
	});

	it('folds only into a mention that is there, is not itself folded, and takes notes', () => {
		const shopping = at(5, { kind: 'lists.shoppingItem', title: 'Strings' });
		const mentions = [
			recital,
			at(1, { kind: 'lists.task', title: 'Bring the folder', of: 9 }),
			at(2, { kind: 'lists.task', title: 'Tune it', of: 2 }),
			at(3, { kind: 'lists.task', title: 'Bring water', of: 0 }),
			at(4, { kind: 'lists.task', title: 'A detail of a detail', of: 3 }),
			shopping,
			at(6, { kind: 'lists.task', title: 'Bring the receipt', of: 5 }),
		];
		const out = fold(mentions);
		expect(out.mentions.map((m) => m.index)).toEqual([0, 1, 2, 4, 5, 6]);
		expect(out.mentions[0]?.mention.notes).toBe('Bring water');
	});

	it('adds to notes the event has, without repeating what they say', () => {
		const out = fold([
			at(0, { ...recital.mention, notes: 'Bring blue music book' }),
			at(1, { kind: 'lists.task', title: 'bring blue  music book', of: 0 }),
			at(2, { kind: 'lists.task', title: 'Tickets', amount: '4 EUR', of: 0 }),
		]);
		expect(out.mentions).toHaveLength(1);
		expect(out.mentions[0]?.mention.notes).toBe('Bring blue music book\nTickets, 4 EUR');
	});

	it('leaves a detail on its own when the notes would grow too long', () => {
		const long = 'x'.repeat(FOLDED_NOTES_MAX - 5);
		const out = fold([
			at(0, { ...recital.mention, notes: long }),
			at(1, { kind: 'lists.task', title: 'Bring blue music book', of: 0 }),
		]);
		expect(out.mentions.map((m) => m.index)).toEqual([0, 1]);
		expect(out.mentions[0]?.mention.notes).toBe(long);
	});
});

describe('detailLine and keepsDetail', () => {
	it('writes a detail as one line, without saying a part twice', () => {
		expect(
			detailLine({ kind: 'lists.task', title: 'Bus fee 10 EUR', amount: '10 EUR' }, 'en'),
		).toBe('Bus fee 10 EUR');
		expect(detailLine({ kind: 'board.note', notes: 'Arrive early', timeText: '14:30' }, 'en')).toBe(
			'14:30, Arrive early',
		);
		expect(detailLine({ kind: 'lists.task' }, 'en')).toBeNull();
	});

	it('finds the line in any text of an input', () => {
		const detail: Mention = { kind: 'lists.task', title: 'Bring blue music book' };
		expect(
			keepsDetail({ title: 'Recital', notes: 'Hall\nBring blue music book' }, detail, 'en'),
		).toBe(true);
		expect(keepsDetail({ id: 'cal_1', date: '2026-11-14' }, detail, 'en')).toBe(false);
	});
});

describe('placeReading with details', () => {
	it('keeps notes of an event that hold its own details', () => {
		const text = 'piano recital Sat 14 Nov 15:00. bring blue music book';
		const mentions: Mention[] = [
			{
				...recital.mention,
				quote: 'piano recital Sat 14 Nov 15:00',
				notes: 'Bring blue music book',
			},
			{ kind: 'lists.task', title: 'Bring blue music book', quote: 'bring blue music book', of: 0 },
		];
		expect(placeReading(mentions, [], text, 'en').foreignNotes).toEqual(new Set([0]));
		expect(placeReading(mentions, [], text, 'en', new Map([[1, 0]])).foreignNotes).toEqual(
			new Set(),
		);
	});
});
