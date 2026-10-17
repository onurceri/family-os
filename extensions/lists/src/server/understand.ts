import {
	defineMentionKind,
	endNamed,
	type IndexedMention,
	type MentionContext,
	peopleNamed,
	type Resolution,
	unsureFields,
} from '@famos/sdk';
import { firstWeekday, repeatRule } from '@famos/time';
import {
	CATEGORIES,
	type Category,
	SHOPPING_QUANTITY_MAX,
	SHOPPING_TITLE_MAX,
	splitAnyAmount,
	TASK_TITLE_MAX,
	titleKey,
} from '../contract/index.ts';
import { aiContext, aiContextTasks } from './context.ts';
import { BOUGHT_VISIBLE_MS, namesOf } from './shopping.ts';
import { tables } from './store.ts';

/*
 * What the model may read for lists from a shared message: things to buy, things bought, tasks
 * and tasks done. The model only names them; the resolvers find the lists, items and tasks they
 * mean in this extension's own tables, read the days and people, and leave out what is already
 * so.
 */

/** The longest label a change of a listed thing carries (`ReviewLabelSchema`). */
const LABEL_MAX = 200;
const NOTES_MAX = 2000;

const cut = (text: string, max: number) => [...text.trim()].slice(0, max).join('').trim();

const refuse = (
	reason: 'already' | 'unknown' | 'ambiguous' | 'incomplete',
	subject: string | null,
	from: readonly number[],
): Resolution => ({ refuse: { reason, subject, from } });

/**
 * A quantity that is a word describing the product ("a new football" read as quantity "new"): one
 * word with no digit. An amount almost always has a number or takes more than one word ("2 kg",
 * "a dozen"), so this needs no word of any language.
 */
const describes = (quantity: string) => !/\p{N}/u.test(quantity) && !/\s/u.test(quantity);

/** The shopping lists not removed, the first one being the default list. */
const activeLists = (ctx: MentionContext) =>
	tables(ctx.db)
		.selectFrom('lists_shopping_lists')
		.select(['id', 'name'])
		.where('archived_at', 'is', null)
		.orderBy('sort')
		.orderBy('created_at')
		.execute();

/** The list `place` words name, by any name it answers to; null when they name none. */
function listNamed(
	ctx: MentionContext,
	lists: readonly { id: string; name: string }[],
	place: string | undefined,
): string | null {
	if (!place) return null;
	const names = lists.flatMap((l) => namesOf(l).map((label) => ({ id: l.id, label })));
	const found = ctx.target(place, names);
	return 'found' in found ? found.found.id : null;
}

export const shoppingItem = defineMentionKind({
	id: 'lists.shoppingItem',
	describe:
		'Something the family must buy: groceries, household supplies, a thing someone needs for school. One mention per product. Not something to bring that a family usually has already (that is lists.task), and not news that something was bought (lists.bought). Something already on the list is still read as something to buy.',
	slots: {
		title:
			'The product as a list entry in the family language, with a capital first letter and without its amount ("Milk"); brand names as written',
		quantity:
			'How much, with its unit, as written ("2 litres", "a dozen", "1 pack"); never a word that describes the product ("new", "big"); left out when no amount is given',
		place: 'The list it goes on, only when the message names one ("the Hardware store list")',
		variant: 'The store section, when it is obvious',
	},
	variants: CATEGORIES,
	actions: ['lists.addShoppingItems'],
	knownFrom: [aiContext.id],
	examples: [
		{
			text: 'Can you grab 2 litres of milk, a dozen eggs and bananas on your way home?',
			mentions: [
				{
					kind: 'lists.shoppingItem',
					quote: '2 litres of milk',
					title: 'Milk',
					quantity: '2 litres',
					variant: 'dairy',
				},
				{
					kind: 'lists.shoppingItem',
					quote: 'a dozen eggs',
					title: 'Eggs',
					quantity: 'a dozen',
					variant: 'dairy',
				},
				{ kind: 'lists.shoppingItem', quote: 'bananas', title: 'Bananas', variant: 'produce' },
			],
		},
		{
			text: 'ice cream and a new football pls',
			mentions: [
				{ kind: 'lists.shoppingItem', quote: 'ice cream', title: 'Ice cream', variant: 'frozen' },
				{ kind: 'lists.shoppingItem', quote: 'a new football', title: 'Football' },
			],
			why: '"new" describes the ball, it is not an amount.',
		},
		{
			text: 'Put picture hooks on the Hardware store list',
			mentions: [
				{
					kind: 'lists.shoppingItem',
					quote: 'Put picture hooks on the Hardware store list',
					title: 'Picture hooks',
					place: 'Hardware store',
				},
			],
		},
		{
			text: 'Got the bread, we still need batteries',
			mentions: [
				{ kind: 'lists.bought', quote: 'Got the bread', target: 'bread' },
				{
					kind: 'lists.shoppingItem',
					quote: 'we still need batteries',
					title: 'Batteries',
					variant: 'household',
				},
			],
			why: 'News that something was bought ticks it off; what is still needed is added.',
		},
		{
			text: 'We should get a new kettle at the weekend',
			mentions: [
				{
					kind: 'lists.shoppingItem',
					quote: 'get a new kettle',
					title: 'Kettle',
					variant: 'household',
				},
			],
			why: 'A thing still to buy goes on the list, also one the household will keep for years.',
		},
	],
	async resolve(ctx, mentions) {
		const lists = await activeLists(ctx);
		const fallback = lists[0];
		if (!fallback)
			return mentions.map((m) => refuse('incomplete', m.mention.title ?? null, [m.index]));
		const open = await tables(ctx.db)
			.selectFrom('lists_shopping_items')
			.select(['list_id', 'title_key'])
			.where('done_at', 'is', null)
			.where('deleted_at', 'is', null)
			.execute();
		const units = ctx.vocabulary('lists:quantity_units');
		const out: Resolution[] = [];
		type Line = { title: string; quantity?: string; category?: Category; key: string };
		const groups = new Map<string, { lines: Line[]; from: number[]; uncertain: Set<string> }>();
		for (const { index, mention } of mentions) {
			let title = mention.title?.trim() ?? '';
			let quantity = mention.quantity?.trim() ?? '';
			if (title === '') {
				out.push(refuse('incomplete', null, [index]));
				continue;
			}
			// An amount the model left in the title ("2 kg Tomatoes") is the quantity.
			if (quantity === '') {
				const split = splitAnyAmount(title, units);
				if (split.quantity && split.title) {
					title = split.title;
					quantity = split.quantity;
				}
			}
			title = cut(title, SHOPPING_TITLE_MAX);
			let doubted = false;
			if (quantity !== '' && describes(quantity)) {
				quantity = '';
				doubted = true;
			}
			quantity = cut(quantity, SHOPPING_QUANTITY_MAX);
			const listId = listNamed(ctx, lists, mention.place) ?? fallback.id;
			const key = titleKey(title, ctx.locale);
			if (open.some((o) => o.list_id === listId && o.title_key === key)) {
				out.push(refuse('already', title, [index]));
				continue;
			}
			const group = groups.get(listId) ?? { lines: [], from: [], uncertain: new Set<string>() };
			groups.set(listId, group);
			group.from.push(index);
			// The same product twice in one message is one line.
			let at = group.lines.findIndex((line) => line.key === key);
			if (at < 0) {
				at = group.lines.length;
				group.lines.push({ title, key });
			}
			const line = group.lines[at] as Line;
			if (quantity !== '' && !line.quantity) line.quantity = quantity;
			const category = CATEGORIES.find((c) => c === mention.variant);
			if (category && !line.category) line.category = category;
			const fields = { title: 'title', quantity: 'quantity', variant: 'category' } as const;
			const doubts = [...unsureFields(mention, fields), ...(doubted ? ['quantity'] : [])];
			for (const field of doubts) group.uncertain.add(`items.${at}.${field}`);
		}
		for (const [listId, group] of groups) {
			out.push({
				propose: {
					actionId: 'lists.addShoppingItems',
					input: {
						...(listId !== fallback.id && { listId }),
						items: group.lines.map(({ key: _key, ...line }) => line),
					},
					subject: group.lines.map((line) => line.title).join(', '),
					uncertain: [...group.uncertain],
					from: group.from,
				},
			});
		}
		return out;
	},
});

export const bought = defineMentionKind({
	id: 'lists.bought',
	describe:
		'News that something on a shopping list was bought or got ("got the light bulbs", "picked up the bread"), so it is ticked off. Only for things bought; something still to buy is lists.shoppingItem.',
	slots: {
		target: 'The thing bought, as the message writes it ("the light bulbs")',
		place: 'The list it is on, only when the message names one',
	},
	actions: ['lists.checkShoppingItem'],
	knownFrom: [aiContext.id],
	examples: [
		{
			text: 'Got the E27 light bulbs already, tick them off the Hardware store list',
			mentions: [
				{
					kind: 'lists.bought',
					quote: 'Got the E27 light bulbs already',
					target: 'E27 light bulbs',
					place: 'Hardware store',
				},
			],
		},
		{
			text: 'picked up bread and eggs',
			mentions: [
				{ kind: 'lists.bought', quote: 'picked up bread', target: 'bread' },
				{ kind: 'lists.bought', quote: 'eggs', target: 'eggs' },
			],
		},
	],
	async resolve(ctx, mentions) {
		const lists = await activeLists(ctx);
		const rows = await tables(ctx.db)
			.selectFrom('lists_shopping_items')
			.innerJoin('lists_shopping_lists', 'lists_shopping_lists.id', 'lists_shopping_items.list_id')
			.select([
				'lists_shopping_items.id as id',
				'lists_shopping_items.title as label',
				'lists_shopping_items.list_id as listId',
				'lists_shopping_items.done_at as doneAt',
			])
			.where('lists_shopping_items.deleted_at', 'is', null)
			.where('lists_shopping_lists.archived_at', 'is', null)
			.where((eb) =>
				eb.or([
					eb('lists_shopping_items.done_at', 'is', null),
					eb('lists_shopping_items.done_at', '>=', ctx.now - BOUGHT_VISIBLE_MS),
				]),
			)
			.execute();
		const out: Resolution[] = [];
		const ticks = new Map<string, { words: string; title: string; from: number[] }>();
		for (const { index, mention } of mentions) {
			const words = (mention.target ?? mention.title)?.trim() ?? '';
			if (words === '') {
				out.push(refuse('incomplete', null, [index]));
				continue;
			}
			const listId = listNamed(ctx, lists, mention.place);
			const pool = listId === null ? rows : rows.filter((r) => r.listId === listId);
			const found = ctx.target(
				words,
				pool.filter((r) => r.doneAt === null),
			);
			if ('found' in found) {
				const tick = ticks.get(found.found.id);
				if (tick) tick.from.push(index);
				else ticks.set(found.found.id, { words, title: found.found.label, from: [index] });
				continue;
			}
			if ('ambiguous' in found) {
				out.push(refuse('ambiguous', words, [index]));
				continue;
			}
			// Ticked off in the last days: the news is already on the list.
			const done = ctx.target(
				words,
				pool.filter((r) => r.doneAt !== null),
			);
			out.push(refuse('found' in done ? 'already' : 'unknown', words, [index]));
		}
		for (const [id, tick] of ticks)
			out.push({
				propose: {
					actionId: 'lists.checkShoppingItem',
					input: { id, done: true, label: cut(tick.words, LABEL_MAX) },
					subject: tick.words,
					targetTitle: tick.title,
					from: tick.from,
				},
			});
		return out;
	},
});

/** Input fields of a task, by the slots that fill them. */
const TASK_FIELDS = {
	title: 'title',
	people: 'assigneeId',
	date: 'dueDate',
	time: 'dueTime',
	repeat: 'recurrence',
	notes: 'notes',
} as const;

export const task = defineMentionKind({
	id: 'lists.task',
	describe:
		'Something a person must do, often by a deadline: pay a fee, sign and return a form, call someone, book an appointment, bring something the family has. Not something that happens at a set time (that is calendar.event) and not something to buy (lists.shoppingItem).',
	slots: {
		title: 'What needs doing, short, in the family language ("Pay the trip fee")',
		people:
			'Who must do it, only when the message names them or says "me"/"my"; left out when nobody is named, never the person who shared it by default',
		date: 'The deadline ("by Friday", "before the end of the month")',
		time: 'The deadline time, only when written',
		repeat: 'Only for chores the message says repeat',
		notes: 'Details worth keeping, saying what an amount is for ("Fee: 45")',
	},
	actions: ['lists.addTask'],
	knownFrom: [aiContextTasks.id],
	examples: [
		{
			text: 'Please pay the trip fee of 14 through the school office by Friday 23 October.',
			mentions: [
				{
					kind: 'lists.task',
					quote: 'Please pay the trip fee of 14 through the school office by Friday 23 October.',
					title: 'Pay the trip fee',
					date: { text: 'Friday 23 October', day: 23, month: 10, weekday: 5 },
					notes: 'Fee: 14, through the school office',
				},
			],
		},
		{
			text: 'Swim club: the autumn term fee is due on the 15th. Please pay at the front desk.',
			mentions: [
				{
					kind: 'lists.task',
					quote: 'the autumn term fee is due on the 15th. Please pay at the front desk.',
					title: 'Pay the swim club term fee',
					date: { text: 'on the 15th', day: 15 },
					notes: 'Pay at the front desk',
				},
			],
			why: 'Nobody is named, so nobody is given the task.',
		},
		{
			text: 'Sam, can you call the plumber tomorrow? And remind me to renew my passport before the end of the month',
			mentions: [
				{
					kind: 'lists.task',
					quote: 'Sam, can you call the plumber tomorrow?',
					title: 'Call the plumber',
					people: ['Sam'],
					date: { text: 'tomorrow', inDays: 1 },
				},
				{
					kind: 'lists.task',
					quote: 'remind me to renew my passport before the end of the month',
					title: 'Renew the passport',
					forMe: true,
					date: { text: 'before the end of the month', approximate: true },
				},
			],
			why: '"Me" and "my" are the person who shared it; the end of a span is copied as words.',
		},
		{
			text: 'I paid the swim course fee, still need to book the dentist',
			mentions: [
				{ kind: 'lists.taskDone', quote: 'I paid the swim course fee', target: 'swim course fee' },
				{
					kind: 'lists.task',
					quote: 'still need to book the dentist',
					title: 'Book the dentist',
					forMe: true,
				},
			],
			why: 'News that a task is done completes it; it is not a new task.',
		},
	],
	async resolve(ctx, mentions) {
		const rows = await tables(ctx.db)
			.selectFrom('lists_tasks')
			.select(['title', 'due_date', 'done_at'])
			.where('deleted_at', 'is', null)
			.execute();
		const out: Resolution[] = [];
		const made: { key: string; due: string | null; from: number[] }[] = [];
		for (const { index, mention } of mentions) {
			const title = cut(mention.title ?? '', TASK_TITLE_MAX);
			if (title === '') {
				out.push(refuse('incomplete', mention.target ?? null, [index]));
				continue;
			}
			const uncertain = new Set(unsureFields(mention, TASK_FIELDS));
			// A deadline named by a month or a span is its last day.
			const day = mention.date ? endNamed(ctx, mention.date) : null;
			if (mention.date && !day?.certain) uncertain.add('dueDate');
			let dueDate = day?.date ?? null;
			let recurrence: unknown;
			if (mention.repeat) {
				const repeat = mention.repeat;
				const weekdays = repeat.every === 'week' ? (repeat.weekdays ?? []) : [];
				// A repeating task needs a first due date: the first day it repeats on from today.
				if (dueDate === null) {
					dueDate = weekdays.length > 0 ? firstWeekday(ctx.today, weekdays) : ctx.today;
					if (weekdays.length === 0) uncertain.add('dueDate');
				}
				const until = repeat.until ? endNamed(ctx, repeat.until) : null;
				const rule = repeatRule(repeat, dueDate, until?.date);
				if (!rule.exact || (repeat.until && !until?.certain)) uncertain.add('recurrence');
				dueDate = rule.start;
				recurrence = rule.recurrence;
			}
			const time = dueDate ? ctx.time(mention) : null;
			if (time && !time.certain) uncertain.add('dueTime');
			const people = peopleNamed(ctx, mention);
			const assigneeId = people.ids.length === 1 ? (people.ids[0] as string) : undefined;
			// Several people for one task: whose it is, is for a person to say.
			if (people.ids.length > 1 || (assigneeId && !people.certain)) uncertain.add('assigneeId');
			const key = titleKey(title, ctx.locale);
			const twice = made.find((m) => m.key === key && m.due === dueDate);
			if (twice) {
				twice.from.push(index);
				continue;
			}
			// The same task already on the list for the same deadline; one done long ago without a
			// deadline is not the same piece of work as a new one.
			const there = rows.some(
				(r) =>
					titleKey(r.title, ctx.locale) === key &&
					r.due_date === dueDate &&
					(r.done_at === null || r.due_date !== null),
			);
			if (there) {
				out.push(refuse('already', title, [index]));
				continue;
			}
			const notes = mention.notes ? cut(mention.notes, NOTES_MAX) : '';
			const proposal = {
				actionId: 'lists.addTask',
				input: {
					title,
					...(assigneeId && { assigneeId }),
					...(dueDate && { dueDate }),
					...(dueDate && time && { dueTime: time.time }),
					...(recurrence !== undefined && { recurrence }),
					...(notes && { notes }),
				},
				subject: title,
				uncertain: [...uncertain],
				from: [index],
			};
			made.push({ key, due: dueDate, from: proposal.from });
			out.push({ propose: proposal });
		}
		return out;
	},
});

export const taskDone = defineMentionKind({
	id: 'lists.taskDone',
	describe:
		'News that a task on the list is done ("I paid the swim course fee", "the form is signed and back"), so it is completed. Not a new task.',
	slots: { target: 'The task as the message writes it ("the swim course fee")' },
	actions: ['lists.completeTask'],
	knownFrom: [aiContextTasks.id],
	examples: [
		{
			text: 'I paid the swim course fee this morning.',
			mentions: [
				{
					kind: 'lists.taskDone',
					quote: 'I paid the swim course fee this morning',
					target: 'swim course fee',
				},
			],
		},
		{
			text: 'The permission slip is signed and back at school',
			mentions: [
				{
					kind: 'lists.taskDone',
					quote: 'The permission slip is signed and back at school',
					target: 'permission slip',
				},
			],
		},
	],
	async resolve(ctx, mentions) {
		const rows = await tables(ctx.db)
			.selectFrom('lists_tasks')
			.select(['id', 'title as label', 'due_date as dueDate', 'done_at as doneAt'])
			.where('deleted_at', 'is', null)
			.execute();
		const open = rows.filter((r) => r.doneAt === null);
		const done = rows.filter((r) => r.doneAt !== null);
		const out: Resolution[] = [];
		const completions = new Map<
			string,
			{ words: string; row: (typeof rows)[number]; from: number[] }
		>();
		for (const { index, mention } of mentions as readonly IndexedMention[]) {
			const words = (mention.target ?? mention.title)?.trim() ?? '';
			if (words === '') {
				out.push(refuse('incomplete', null, [index]));
				continue;
			}
			const found = ctx.target(words, open);
			if ('found' in found) {
				const seen = completions.get(found.found.id);
				if (seen) seen.from.push(index);
				else completions.set(found.found.id, { words, row: found.found, from: [index] });
				continue;
			}
			if ('ambiguous' in found) {
				out.push(refuse('ambiguous', words, [index]));
				continue;
			}
			out.push(refuse('found' in ctx.target(words, done) ? 'already' : 'unknown', words, [index]));
		}
		for (const [id, { words, row, from }] of completions)
			out.push({
				propose: {
					actionId: 'lists.completeTask',
					input: { id, label: cut(words, LABEL_MAX), dueDate: row.dueDate },
					subject: words,
					targetTitle: row.label,
					from,
				},
			});
		return out;
	},
});

export const listKinds = [shoppingItem, bought, task, taskDone];
