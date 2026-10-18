import {
	defineMentionKind,
	type IndexedMention,
	type Mention,
	type MentionContext,
	type MentionRecord,
	namesThing,
	type Resolution,
	whichOne,
} from '@famos/sdk';
import { compareDates } from '@famos/time';
import {
	type Every,
	OBLIGATION_CONTEXT_KIND,
	pickRecord,
	RecordIdSchema,
	RecordKindSchema,
	RecordNameSchema,
	RecordUrlSchema,
} from '../contract/index.ts';
import { aiContext } from './obligations.ts';
import { tables } from './store.ts';

const refuse = (
	reason: 'already' | 'unknown' | 'ambiguous' | 'incomplete',
	subject: string | undefined,
	index: number,
): Resolution => ({ refuse: { reason, subject: subject ?? null, from: [index] } });

/** A repeat by months or years, the only ones a duty has; null when the words give another. */
function everyOf(repeat: Mention['repeat']): Every | null | undefined {
	if (!repeat) return undefined;
	const n = repeat.interval ?? 1;
	if (repeat.every === 'year') return n <= 50 ? { years: n } : null;
	if (repeat.every === 'month') return n <= 120 ? { months: n } : null;
	return null;
}

/**
 * The records of other extensions a reading listed (vehicles, pets, homes): those with a typed
 * id, a kind and a page, so a duty can name them. Obligations themselves are not records.
 */
/** The areas that keep the household records a duty belongs to. */
const HOUSEHOLD_AREAS = ['home', 'vehicles', 'pets'] as const;

const householdRecords = (ctx: MentionContext): MentionRecord[] =>
	ctx.records.filter(
		(r) =>
			r.kind !== OBLIGATION_CONTEXT_KIND &&
			r.url !== undefined &&
			RecordIdSchema.safeParse(r.id).success &&
			RecordKindSchema.safeParse(r.kind).success &&
			RecordNameSchema.safeParse(r.label).success &&
			RecordUrlSchema.safeParse(r.url).success,
	);

async function resolveDuty(ctx: MentionContext, { index, mention }: IndexedMention) {
	const title = mention.title;
	if (!title) return refuse('incomplete', mention.about, index);
	const record = pickRecord(ctx, mention.about, householdRecords(ctx));
	if ('refuse' in record) return refuse(record.refuse, title, index);
	const due = ctx.day(mention.date, 'future');
	if (!due) return refuse('incomplete', title, index);
	const open = await tables(ctx.db)
		.selectFrom('records_obligations')
		.select('title')
		.where('record_id', '=', record.found.id)
		.where('archived_at', 'is', null)
		.execute();
	// A notice about a duty that is already kept (a renewal reminder) asks for nothing new.
	if (open.some((row) => namesThing(title, row.title, { language: ctx.locale })))
		return refuse('already', title, index);
	const lapses = mention.variant === 'ends';
	const every = lapses ? undefined : everyOf(mention.repeat);
	const people = ctx.people(mention);
	const [assigneeId] = people.ids;
	return {
		propose: {
			actionId: 'records.addObligation',
			input: {
				recordId: record.found.id,
				recordKind: record.found.kind,
				recordName: record.found.label,
				recordUrl: record.found.url,
				title,
				dueDate: due.date,
				...(every && { every }),
				...(lapses && { lapses }),
				...(assigneeId && { assigneeId }),
				...(mention.notes && { notes: mention.notes }),
			},
			subject: title,
			uncertain: [
				...(record.certain ? [] : ['recordId']),
				...(due.certain ? [] : ['dueDate']),
				...(every === null ? ['every'] : []),
				...(assigneeId && (!people.certain || people.ids.length > 1) ? ['assigneeId'] : []),
			],
			from: [index],
		},
	} satisfies Resolution;
}

/** The open obligations the reading listed (the AI may see them), as this extension keeps them. */
async function listedObligations(ctx: MentionContext) {
	const listed = new Map(
		ctx.records.filter((r) => r.kind === OBLIGATION_CONTEXT_KIND).map((r) => [r.id, r.label]),
	);
	if (listed.size === 0) return [];
	const rows = await tables(ctx.db)
		.selectFrom('records_obligations')
		.select(['id', 'record_id', 'record_name', 'title', 'due_date'])
		.where('id', 'in', [...listed.keys()])
		.where('archived_at', 'is', null)
		// A date that only passes (a warranty ends) has nothing to mark done.
		.where('lapses', '=', 0)
		.execute();
	return rows.map((row) => ({
		...row,
		listedAs: listed.get(row.id) ?? row.title,
		// The record's name counts when telling two "Car insurance" apart.
		label: `${row.title} ${row.record_name}`,
	}));
}

async function resolveDone(
	ctx: MentionContext,
	{ index, mention }: IndexedMention,
	obligations: Awaited<ReturnType<typeof listedObligations>>,
) {
	const words = mention.target ?? mention.title;
	if (!words) return refuse('incomplete', mention.about, index);
	let candidates = obligations;
	if (mention.about) {
		const records = [
			...new Map(obligations.map((o) => [o.record_id, { id: o.record_id, label: o.record_name }])),
		].map(([, r]) => r);
		const record = pickRecord(ctx, mention.about, records);
		if ('refuse' in record) return refuse(record.refuse, words, index);
		candidates = obligations.filter((o) => o.record_id === record.found.id);
	}
	const found = ctx.target(words, candidates);
	if ('none' in found) return refuse('unknown', words, index);
	if ('ambiguous' in found) return refuse('ambiguous', whichOne(words, found.ambiguous), index);
	const duty = found.found;
	const done = ctx.day(mention.date, 'past');
	const next = ctx.day(mention.endDate, 'future');
	// Something really done comes with the day it happened or the date it now runs to; without
	// either it is a reminder or a renewal notice, and the duty is still to do.
	if (!done && !next) return refuse('incomplete', words, index);
	// Already renewed to that date.
	if (next && next.date === duty.due_date) return refuse('already', words, index);
	const keepsNext = next !== null && (!done || compareDates(next.date, done.date) > 0);
	return {
		propose: {
			actionId: 'records.completeObligation',
			input: {
				id: duty.id,
				dueDate: duty.due_date,
				label: duty.listedAs,
				...(done && { doneOn: done.date }),
				...(keepsNext && { nextDueDate: next.date }),
				...(mention.notes && { note: mention.notes }),
			},
			subject: words,
			targetTitle: duty.title,
			uncertain: [
				...(done && !done.certain ? ['doneOn'] : []),
				// A next date before the one it had is more likely misread than a shorter cover.
				...(keepsNext && (!next.certain || compareDates(next.date, duty.due_date) < 0)
					? ['nextDueDate']
					: []),
				// The new date was read but fell before the day it was done: left out, check it.
				...(next && !keepsNext ? ['doneOn'] : []),
			],
			from: [index],
		},
	} satisfies Resolution;
}

export const dutyKind = defineMentionKind({
	id: 'records.duty',
	describe:
		'A date-bound duty of a household record (a vehicle, a pet, a home, a thing in it) that is not among the listed duties yet: a new policy and when its cover ends, an inspection or a vaccination that is due, a date that only passes (a warranty ends). Not for a reminder or a renewal notice of a listed duty (that needs nothing), and not for news that a duty was done (records.dutyDone).',
	slots: {
		title:
			'What needs doing, in a few words, without the record and without amounts of money ("Car insurance", "Rabies vaccination")',
		about: 'The household record it belongs to, by its listed name',
		date: 'When it is due; for a policy, the last day of its cover',
		repeat: 'How often it comes back, by months or years; leave it out when the words do not say',
		variant:
			'due: something to do by the date; ends: a date that only passes and asks nothing of anyone (a warranty ends)',
		people: 'Who should take care of it, only when the message says',
		notes: 'A short note; no amounts of money',
	},
	variants: ['due', 'ends'],
	actions: ['records.addObligation'],
	knownFrom: [aiContext.id],
	drawsOn: HOUSEHOLD_AREAS,
	examples: [
		{
			text: 'Our new home insurance for the flat starts today and runs until 31 March 2027.',
			mentions: [
				{
					kind: 'records.duty',
					quote: 'Our new home insurance for the flat starts today and runs until 31 March 2027.',
					title: 'Home insurance',
					about: 'Our flat',
					variant: 'due',
					date: { text: '31 March 2027', day: 31, month: 3, year: 2027 },
				},
			],
			why: 'a policy that is not listed yet: the duty is due when its cover ends',
		},
		{
			text: 'Luna needs her rabies booster every year, the next one on 3 May.',
			mentions: [
				{
					kind: 'records.duty',
					quote: 'Luna needs her rabies booster every year, the next one on 3 May.',
					title: 'Rabies vaccination',
					about: 'Luna',
					variant: 'due',
					date: { text: '3 May', day: 3, month: 5 },
					repeat: { every: 'year' },
				},
			],
		},
		{
			text: 'Reminder: your car insurance for the family car is due for renewal on 20 October. Renew before then to stay covered.',
			mentions: [],
			why: 'the car insurance is already listed: a reminder of it asks for nothing new',
		},
		{
			text: 'The family car must pass its inspection by 15 June, and every two years after that.',
			mentions: [
				{
					kind: 'records.duty',
					quote:
						'The family car must pass its inspection by 15 June, and every two years after that.',
					title: 'Vehicle inspection',
					about: 'Family car',
					variant: 'due',
					date: { text: '15 June', day: 15, month: 6 },
					repeat: { every: 'year', interval: 2 },
				},
			],
		},
	],
	decides: {},
	async resolve(ctx, mentions) {
		const out: Resolution[] = [];
		for (const m of mentions) out.push(await resolveDuty(ctx, m));
		return out;
	},
});

export const dutyDoneKind = defineMentionKind({
	id: 'records.dutyDone',
	describe:
		'News that a listed duty has been done: a policy renewed, a payment confirmed, an inspection passed, a vaccination given, a service invoice. Only when the message says the day it was done or the date it now runs to. Never for a reminder, a renewal notice, an offer or a coming due date: those say it is still to do.',
	slots: {
		target: 'The listed duty, by its listed name without the record ("Car insurance")',
		about: 'The household record it belongs to, by its listed name, when the message says',
		date: 'The day it was done (a policy start date, the invoice or payment date)',
		endDate: 'When it is next due or the new cover ends, when the message says',
		notes: 'A short note, e.g. a policy number; no amounts of money',
	},
	actions: ['records.completeObligation'],
	knownFrom: [aiContext.id],
	drawsOn: HOUSEHOLD_AREAS,
	limit: 8,
	examples: [
		{
			text: 'Thank you, your car insurance has been renewed. New period of cover: 20 October 2026 to 19 October 2027.',
			mentions: [
				{
					kind: 'records.dutyDone',
					quote:
						'your car insurance has been renewed. New period of cover: 20 October 2026 to 19 October 2027.',
					target: 'Car insurance',
					date: { text: '20 October 2026', day: 20, month: 10, year: 2026 },
					endDate: { text: '19 October 2027', day: 19, month: 10, year: 2027 },
				},
			],
			why: 'renewed, with the new cover: the listed duty is done and runs to the new end',
		},
		{
			text: 'Your car insurance ends on 20 October. Renew online before then to stay covered.',
			mentions: [],
			why: 'a renewal notice says the duty is still to do',
		},
		{
			text: 'Paid the road tax for the family car this morning.',
			mentions: [
				{
					kind: 'records.dutyDone',
					quote: 'Paid the road tax for the family car this morning.',
					target: 'Road tax',
					about: 'Family car',
					date: { text: 'this morning', inDays: 0 },
				},
			],
		},
	],
	decides: {},
	async resolve(ctx, mentions) {
		const obligations = await listedObligations(ctx);
		const out: Resolution[] = [];
		for (const m of mentions) out.push(await resolveDone(ctx, m, obligations));
		return out;
	},
});
