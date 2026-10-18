import {
	type DigestItem,
	defineDigest,
	digestForPeople,
	digestNotes,
	digestOf,
	type UnitOfWork,
} from '@famos/sdk';
import { addDays, compareDates, expandDates, todayIn } from '@famos/time';
import { sql } from 'kysely';
import { type TaskRow, tables } from './store.ts';
import { listsView } from './tasks.ts';

/** How far past the span the tasks digest looks for the next task due. */
const NEXT_DAYS = 366;

/** How many of a list's things its digest item names. */
const LIST_NAMES = 12;

/**
 * The days a task is due in `[from, to]`: its open due date, then the later dates of its rule. A
 * task still open from before the span counts on the day it was due when the span holds today,
 * since it is still to do.
 */
export function taskDueDays(
	task: Pick<TaskRow, 'due_date' | 'rrule' | 'rrule_start'>,
	from: string,
	to: string,
	today: string,
): string[] {
	const due = task.due_date;
	if (due === null) return [];
	const days: string[] = [];
	const spanHoldsToday = compareDates(from, today) <= 0 && compareDates(today, to) <= 0;
	if (compareDates(due, from) >= 0 ? compareDates(due, to) <= 0 : spanHoldsToday) days.push(due);
	if (task.rrule && task.rrule_start) {
		const start = compareDates(due, from) >= 0 ? addDays(due, 1) : from;
		if (compareDates(start, to) <= 0)
			for (const day of expandDates({ date: task.rrule_start, rrule: task.rrule }, start, to))
				if (compareDates(day, due) > 0) days.push(day);
	}
	return days;
}

const taskItem = (row: TaskRow, date: string, today: string): DigestItem => {
	const notes = digestNotes(row.notes);
	return {
		handle: row.id,
		kind: 'task',
		title: row.title,
		date,
		...(row.due_time && { time: row.due_time }),
		people: row.assignee_id ? [row.assignee_id] : [],
		...(notes && { notes }),
		// Only the open due date can be late; later dates of its rule are still to come.
		...(date === row.due_date && compareDates(date, today) < 0 && { status: 'overdue' as const }),
		...(row.rrule && { extra: { repeats: 'yes' } }),
	};
};

const openDated = (uow: UnitOfWork) =>
	tables(uow.db)
		.selectFrom('lists_tasks')
		.selectAll()
		.where('deleted_at', 'is', null)
		.where('done_at', 'is', null)
		.where('due_date', 'is not', null);

/**
 * The tasks due in a span, for the people asked about and the tasks anyone may do: each date a
 * task is due on (a repeating one on each of its dates), and what is late when the span holds
 * today. Tasks without a due date belong to no day and are not in it.
 */
export const tasksDigest = defineDigest({
	id: 'lists.tasksDigest',
	topic: 'tasks',
	title: 'Tasks due in some days, for an answer',
	description:
		'The tasks due between two days (repeating ones on each date), with their notes and who does them, and the open ones that are late when the days include today.',
	requires: listsView.id,
	async run(uow, input) {
		const { timeZone } = await uow.family.settings();
		const today = todayIn(timeZone, uow.clock.now());
		const forPeople = (row: TaskRow) =>
			digestForPeople(row.assignee_id ? [row.assignee_id] : [], input.memberIds);
		const rows = (
			await openDated(uow)
				.orderBy('due_date')
				.orderBy(sql`due_time is null`)
				.orderBy('due_time')
				.orderBy('created_at')
				.execute()
		).filter(forPeople);
		const items = rows
			.flatMap((row) =>
				taskDueDays(row, input.from, input.to, today).map((day) => taskItem(row, day, today)),
			)
			.sort(
				(a, b) =>
					a.date.localeCompare(b.date) ||
					Number(a.time === undefined) - Number(b.time === undefined) ||
					(a.time ?? '').localeCompare(b.time ?? ''),
			);
		return digestOf(items, input, {
			async next() {
				const after = addDays(input.to, 1);
				const later = rows
					.flatMap((row) => {
						const [day] = taskDueDays(row, after, addDays(after, NEXT_DAYS), today).filter(
							(d) => compareDates(d, after) >= 0,
						);
						return day ? [taskItem(row, day, today)] : [];
					})
					.sort((a, b) => a.date.localeCompare(b.date));
				return later[0] ?? null;
			},
		});
	},
});

/**
 * The shopping lists that still have things to buy, one item per list with how many: shopping
 * belongs to no day, so each stands on the span's first day it is asked about. Nobody's in
 * particular: the people asked about never leave a list out.
 */
export const shoppingDigest = defineDigest({
	id: 'lists.shoppingDigest',
	topic: 'shopping',
	title: 'What is still to buy, for an answer',
	description:
		'One entry per shopping list that still has things to buy: its name, how many things and the first of them.',
	requires: listsView.id,
	async run(uow, input) {
		const { timeZone, locale } = await uow.family.settings();
		const today = todayIn(timeZone, uow.clock.now());
		const date =
			compareDates(today, input.from) < 0
				? input.from
				: compareDates(today, input.to) > 0
					? input.to
					: today;
		const asker = uow.actor.kind === 'ai' ? uow.actor.onBehalfOf : undefined;
		const language =
			(asker && (await uow.family.members()).find((m) => m.id === asker)?.locale) || locale;
		const lists = await tables(uow.db)
			.selectFrom('lists_shopping_lists')
			.selectAll()
			.where('archived_at', 'is', null)
			.orderBy('sort')
			.orderBy('created_at')
			.execute();
		const items: DigestItem[] = [];
		for (const list of lists) {
			const open = await tables(uow.db)
				.selectFrom('lists_shopping_items')
				.select(['title'])
				.where('list_id', '=', list.id)
				.where('deleted_at', 'is', null)
				.where('done_at', 'is', null)
				.orderBy('created_at')
				.execute();
			if (open.length === 0) continue;
			const names = open
				.slice(0, LIST_NAMES)
				.map((r) => r.title)
				.join(', ');
			items.push({
				handle: list.id,
				kind: 'shopping_list',
				title: list.name || uow.translate(language, 'lists:default_list'),
				date,
				people: [],
				extra: {
					open: String(open.length),
					things: names.length > 300 ? `${names.slice(0, 299)}…` : names,
				},
			});
		}
		return digestOf(items, input);
	},
});
