import {
	defineMentionKind,
	type IndexedMention,
	type Mention,
	type MentionContext,
	type Resolution,
	whichOne,
} from '@famos/sdk';
import { type Recurrence, Temporal, WEEKDAYS } from '@famos/time';
import { tables } from './store.ts';

const MONTHS_IN_YEAR = 12;
const MAX_MONTHLY = 12;

const refuse = (
	reason: 'already' | 'unknown' | 'ambiguous' | 'incomplete',
	subject: string | null,
	index: number,
): Resolution => ({ refuse: { reason, subject, from: [index] } });

const same = (a: string, b: string) =>
	a.trim().replace(/\s+/gu, ' ').toLocaleLowerCase() ===
	b.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();

/**
 * How a chore repeats, from the repeat a mention reads: by days, weeks (on the weekdays it names,
 * else the weekday of the first day) or months; a yearly chore is one every twelve months. Null
 * when it cannot be kept (every two years).
 */
export function recurrenceOf(
	repeat: NonNullable<Mention['repeat']>,
	start: string,
	until: string | undefined,
): Recurrence | null {
	const n = repeat.interval ?? 1;
	const end = until ? { until } : {};
	if (repeat.every === 'day') return n <= 365 ? { freq: 'daily', interval: n, ...end } : null;
	if (repeat.every === 'week') {
		const days = repeat.weekdays?.length
			? [...new Set(repeat.weekdays)].toSorted((a, b) => a - b)
			: [Temporal.PlainDate.from(start).dayOfWeek];
		const byDay = days.map((d) => WEEKDAYS[d - 1]).filter((d) => d !== undefined);
		return n <= 52 ? { freq: 'weekly', interval: n, byDay, ...end } : null;
	}
	const months = repeat.every === 'year' ? n * MONTHS_IN_YEAR : n;
	return months <= MAX_MONTHLY ? { freq: 'monthly', interval: months, ...end } : null;
}

/** The chores still to do, with whose turns they are, for finding one by its name. */
async function openChores(ctx: MentionContext) {
	const rows = await tables(ctx.db)
		.selectFrom('chores_chores')
		.select(['id', 'title as label', 'next_due'])
		.where('archived_at', 'is', null)
		.execute();
	const order = await tables(ctx.db)
		.selectFrom('chores_assignees')
		.select(['chore_id', 'member_id'])
		.orderBy('position')
		.execute();
	return rows.map((r) => ({
		...r,
		memberIds: order.filter((o) => o.chore_id === r.id).map((o) => o.member_id),
	}));
}
type OpenChore = Awaited<ReturnType<typeof openChores>>[number];

function resolveChore(
	ctx: MentionContext,
	{ index, mention }: IndexedMention,
	chores: readonly OpenChore[],
): Resolution {
	const title = mention.title;
	if (!title) return refuse('incomplete', null, index);
	if (chores.some((c) => same(c.label, title))) return refuse('already', title, index);
	const start = ctx.day(mention.date, 'future');
	const startDate = start?.date ?? ctx.today;
	const until = mention.repeat?.until ? ctx.day(mention.repeat.until, 'future') : null;
	const recurrence = mention.repeat ? recurrenceOf(mention.repeat, startDate, until?.date) : null;
	const people = ctx.people(mention);
	return {
		propose: {
			actionId: 'chores.createChore',
			input: {
				title,
				startDate,
				...(recurrence && { recurrence }),
				assigneeIds: people.ids,
				// Several people take turns; one is always the same person.
				rotation: people.ids.length > 1 ? 'round_robin' : 'fixed',
				...(mention.notes && { notes: mention.notes }),
			},
			subject: title,
			// No start day said: today, which a person is asked to confirm.
			...(!start && { decided: { startDate: 'defaulted' as const } }),
			uncertain: [
				...(start && !start.certain ? ['startDate'] : []),
				...(mention.repeat && (!recurrence || (until && !until.certain)) ? ['recurrence'] : []),
				...(people.ids.length > 0 && !people.certain ? ['assigneeIds'] : []),
			],
			from: [index],
		},
	};
}

function resolveDone(
	ctx: MentionContext,
	{ index, mention }: IndexedMention,
	chores: readonly OpenChore[],
): Resolution {
	const words = mention.target ?? mention.title;
	if (!words) return refuse('incomplete', null, index);
	const found = ctx.target(
		words,
		chores.filter((c) => c.next_due !== null),
	);
	if ('none' in found) {
		// A one-off chore that is done already is not missing.
		const finished = chores.filter((c) => c.next_due === null);
		return refuse('found' in ctx.target(words, finished) ? 'already' : 'unknown', words, index);
	}
	if ('ambiguous' in found) return refuse('ambiguous', whichOne(words, found.ambiguous), index);
	const chore = found.found;
	const people = ctx.people(mention);
	const [doneBy] = people.ids;
	return {
		propose: {
			actionId: 'chores.markDone',
			input: { id: chore.id, dueDate: chore.next_due, label: words, ...(doneBy && { doneBy }) },
			subject: words,
			targetTitle: chore.label,
			uncertain: doneBy && (!people.certain || people.ids.length > 1) ? ['doneBy'] : [],
			from: [index],
		},
	};
}

function resolveTurns(
	ctx: MentionContext,
	{ index, mention }: IndexedMention,
	chores: readonly OpenChore[],
): Resolution {
	const words = mention.target ?? mention.title;
	if (!words) return refuse('incomplete', null, index);
	const people = ctx.people(mention);
	// Who takes turns comes only from names: nobody named is no change, not "anyone".
	if (people.ids.length === 0) return refuse('incomplete', words, index);
	const found = ctx.target(words, chores);
	if ('none' in found) return refuse('unknown', words, index);
	if ('ambiguous' in found) return refuse('ambiguous', whichOne(words, found.ambiguous), index);
	const chore = found.found;
	if (people.ids.join() === chore.memberIds.join()) return refuse('already', words, index);
	return {
		propose: {
			actionId: 'chores.setAssignees',
			input: { id: chore.id, memberIds: people.ids, choreTitle: chore.label },
			subject: words,
			targetTitle: chore.label,
			uncertain: people.certain ? [] : ['memberIds'],
			from: [index],
		},
	};
}

const each =
	(one: (ctx: MentionContext, m: IndexedMention, chores: readonly OpenChore[]) => Resolution) =>
	async (ctx: MentionContext, mentions: readonly IndexedMention[]) => {
		const chores = await openChores(ctx);
		return mentions.map((m) => one(ctx, m, chores));
	};

export const choreKind = defineMentionKind({
	id: 'chores.chore',
	describe:
		'Shared housework the family wants organised, that repeats or is done once (take out the bins, empty the dishwasher, water the plants), with the people who take turns. Not one person’s own to-do (a task), and not a chore that is already listed.',
	slots: {
		title: 'The chore, in a few words ("Take out the bins")',
		people: 'Who takes turns, in the order the message gives; only people it names',
		date: 'The first day it is due, when the message says',
		repeat: 'How often it comes back',
		notes: 'A short note',
	},
	actions: ['chores.createChore'],
	limit: 8,
	examples: [
		{
			text: 'From Monday Ivy and Leo take turns emptying the dishwasher, every day',
			mentions: [
				{
					kind: 'chores.chore',
					quote: 'From Monday Ivy and Leo take turns emptying the dishwasher, every day',
					title: 'Empty the dishwasher',
					people: ['Ivy', 'Leo'],
					date: { text: 'Monday', weekday: 1 },
					repeat: { every: 'day' },
				},
			],
		},
		{
			text: 'Someone has to water the plants every Saturday',
			mentions: [
				{
					kind: 'chores.chore',
					quote: 'Someone has to water the plants every Saturday',
					title: 'Water the plants',
					repeat: { every: 'week', weekdays: [6] },
				},
			],
			why: 'nobody is named, so anyone may do it',
		},
	],
	decides: { startDate: 'defaulted' },
	resolve: each(resolveChore),
});

export const doneKind = defineMentionKind({
	id: 'chores.done',
	describe:
		'News that a listed chore was done ("I took out the bins", "Leo emptied the dishwasher"). Not for a chore still to do.',
	slots: {
		target: 'The chore, by its name',
		people: 'Who did it, when the message says; the person sharing it when they say "I"',
	},
	actions: ['chores.markDone'],
	limit: 8,
	examples: [
		{
			text: 'Leo emptied the dishwasher',
			mentions: [
				{
					kind: 'chores.done',
					quote: 'Leo emptied the dishwasher',
					target: 'Empty the dishwasher',
					people: ['Leo'],
				},
			],
		},
		{
			text: 'I took the bins out',
			mentions: [
				{
					kind: 'chores.done',
					quote: 'I took the bins out',
					target: 'Take out the bins',
					forMe: true,
				},
			],
		},
	],
	decides: {},
	resolve: each(resolveDone),
});

export const turnsKind = defineMentionKind({
	id: 'chores.turns',
	describe:
		'A change of who takes turns on a listed chore ("from now on Ivy and Sam do the bins"). Only when the message names the people.',
	slots: {
		target: 'The chore, by its name',
		people: 'Who takes turns from now on, in the order the message gives',
	},
	actions: ['chores.setAssignees'],
	limit: 8,
	examples: [
		{
			text: 'From now on Sam and Ivy share the bins, Sam first',
			mentions: [
				{
					kind: 'chores.turns',
					quote: 'Sam and Ivy share the bins, Sam first',
					target: 'Take out the bins',
					people: ['Sam', 'Ivy'],
				},
			],
		},
	],
	decides: {},
	resolve: each(resolveTurns),
});
