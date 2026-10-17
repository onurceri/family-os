import { pickRecord } from '@famos/ext-records/contract';
import {
	defineMentionKind,
	type IndexedMention,
	type Mention,
	type MentionContext,
	type Resolution,
} from '@famos/sdk';
import { Temporal } from '@famos/time';
import { aiContext, aiContextItems } from './context.ts';
import { tables } from './store.ts';

const SHORT_MAX = 60;
const MONTHS_MAX = 600;

type Home = { id: string; label: string };
type Thing = {
	id: string;
	label: string;
	home_id: string;
	brand: string;
	model: string;
	room: string;
	purchased_on: string | null;
	warranty_until: string | null;
};

const short = (value: string | undefined) => value?.trim().slice(0, SHORT_MAX).trim() || undefined;

/** A warranty length in whole months, as the mention writes it ("24"). */
function monthsOf(amount: string | undefined): number | null {
	const m = /^\s*(\d{1,3})\s*$/u.exec(amount ?? '');
	const n = m ? Number(m[1]) : 0;
	return n >= 1 && n <= MONTHS_MAX ? n : null;
}

/**
 * The last day of the warranty: the date the message gives, else the purchase day plus the
 * length it gives. Certain only when what it rests on is.
 */
function warrantyOf(
	ctx: MentionContext,
	mention: Mention,
	bought: { date: string; certain: boolean } | null,
): { date: string; certain: boolean } | null {
	const until = ctx.day(mention.endDate, 'future');
	if (until) return until;
	const months = monthsOf(mention.amount);
	if (months === null) return null;
	const from = bought ?? { date: ctx.today, certain: false };
	return {
		date: Temporal.PlainDate.from(from.date).add({ months }).toString(),
		certain: from.certain,
	};
}

function resolveChange(
	ctx: MentionContext,
	{ index, mention }: IndexedMention,
	things: readonly Thing[],
): Resolution {
	const words = mention.target as string;
	const found = ctx.target(words, things);
	if ('none' in found) return { refuse: { reason: 'unknown', subject: words, from: [index] } };
	if ('ambiguous' in found)
		return { refuse: { reason: 'ambiguous', subject: words, from: [index] } };
	const thing = found.found;
	const bought = ctx.day(mention.date, 'past');
	const warranty = warrantyOf(
		ctx,
		mention,
		bought ?? (thing.purchased_on ? { date: thing.purchased_on, certain: true } : null),
	);
	const [brand, model] = (mention.lines ?? []).map(short);
	// Only what the message states and the thing does not have yet: the rest stays as it is.
	const patch = {
		...(brand && brand !== thing.brand && { brand }),
		...(model && model !== thing.model && { model }),
		...(short(mention.place) &&
			short(mention.place) !== thing.room && { room: short(mention.place) }),
		...(bought && bought.date !== thing.purchased_on && { purchasedOn: bought.date }),
		...(warranty && warranty.date !== thing.warranty_until && { warrantyUntil: warranty.date }),
	};
	if (Object.keys(patch).length === 0)
		return { refuse: { reason: 'already', subject: words, from: [index] } };
	return {
		propose: {
			actionId: 'home.updateItem',
			input: { id: thing.id, itemName: thing.label, ...patch },
			subject: words,
			targetTitle: thing.label,
			uncertain: [
				...('purchasedOn' in patch && bought && !bought.certain ? ['purchasedOn'] : []),
				...('warrantyUntil' in patch && warranty && !warranty.certain ? ['warrantyUntil'] : []),
			],
			from: [index],
		},
	};
}

function resolveNew(
	ctx: MentionContext,
	{ index, mention }: IndexedMention,
	homes: readonly Home[],
	things: readonly Thing[],
): Resolution {
	const name = mention.title;
	if (!name) return { refuse: { reason: 'incomplete', subject: null, from: [index] } };
	const home = pickRecord(ctx, mention.about, homes);
	if ('refuse' in home) return { refuse: { reason: home.refuse, subject: name, from: [index] } };
	const [brand = '', model = ''] = (mention.lines ?? []).map((line) => short(line) ?? '');
	const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
	if (
		things.some(
			(t) =>
				t.home_id === home.found.id &&
				same(t.label, name) &&
				same(t.brand, brand) &&
				same(t.model, model),
		)
	)
		return { refuse: { reason: 'already', subject: name, from: [index] } };
	const bought = ctx.day(mention.date, 'past');
	const warranty = warrantyOf(ctx, mention, bought);
	const room = short(mention.place);
	return {
		propose: {
			actionId: 'home.addItem',
			input: {
				homeId: home.found.id,
				homeName: home.found.label,
				name,
				...(brand && { brand }),
				...(model && { model }),
				...(room && { room }),
				...(bought && { purchasedOn: bought.date }),
				...(warranty && { warrantyUntil: warranty.date }),
				...(mention.notes && { notes: mention.notes }),
			},
			subject: name,
			uncertain: [
				...(home.certain ? [] : ['homeId']),
				...(bought && !bought.certain ? ['purchasedOn'] : []),
				...(warranty && !warranty.certain ? ['warrantyUntil'] : []),
			],
			from: [index],
		},
	};
}

export const itemKind = defineMentionKind({
	id: 'home.item',
	describe:
		'A durable thing the household owns (an appliance, electronics, furniture), from a receipt, an invoice or a warranty card: one just bought, or new facts about a listed thing (its warranty was extended). Not for something still to buy (that goes on the shopping list).',
	slots: {
		title: 'What the thing is, in a few words ("Washing machine")',
		target:
			'A listed thing the message is about, by its listed name; leave it out for something newly bought',
		about: 'The home it is in, by its listed name',
		lines: 'The brand and then the model, as printed (["Samsung", "RB38"])',
		date: 'The day it was bought (the receipt or invoice date)',
		endDate: 'The last day of the warranty, when the message gives it',
		amount: 'The length of the warranty in months, digits only ("24"), when only a length is given',
		place: 'The room it is in, only when the message says',
		notes: 'A short note; no serial numbers and no amounts of money',
	},
	actions: ['home.addItem', 'home.updateItem'],
	knownFrom: [aiContext.id, aiContextItems.id],
	limit: 8,
	examples: [
		{
			text: 'Receipt: Samsung RB38 fridge, 05.10.2026, 2 years warranty',
			mentions: [
				{
					kind: 'home.item',
					quote: 'Samsung RB38 fridge, 05.10.2026, 2 years warranty',
					title: 'Fridge',
					lines: ['Samsung', 'RB38'],
					date: { text: '05.10.2026', numeric: '05.10.2026' },
					amount: '24',
				},
			],
			why: 'a durable thing bought; code works out the end of a warranty given as a length',
		},
		{
			text: 'Extended warranty certificate for your washing machine: covered until 20.09.2029',
			mentions: [
				{
					kind: 'home.item',
					quote: 'warranty certificate for your washing machine: covered until 20.09.2029',
					target: 'Washing machine',
					endDate: { text: '20.09.2029', numeric: '20.09.2029' },
				},
			],
			why: 'news about a listed thing changes it',
		},
	],
	async resolve(ctx, mentions) {
		const homes: Home[] = await tables(ctx.db)
			.selectFrom('home_homes')
			.select(['id', 'name as label'])
			.where('archived_at', 'is', null)
			.orderBy('created_at')
			.execute();
		const things: Thing[] = await tables(ctx.db)
			.selectFrom('home_items')
			.innerJoin('home_homes', 'home_homes.id', 'home_items.home_id')
			.select([
				'home_items.id as id',
				'home_items.name as label',
				'home_items.home_id as home_id',
				'home_items.brand as brand',
				'home_items.model as model',
				'home_items.room as room',
				'home_items.purchased_on as purchased_on',
				'home_items.warranty_until as warranty_until',
			])
			.where('home_items.archived_at', 'is', null)
			.where('home_homes.archived_at', 'is', null)
			.orderBy('home_items.created_at')
			.execute();
		return mentions.map((m) =>
			m.mention.target ? resolveChange(ctx, m, things) : resolveNew(ctx, m, homes, things),
		);
	},
});
