import { type DigestItem, defineDigest, digestForPeople, digestNotes, digestOf } from '@famos/sdk';
import { addDays, compareDates, type Recurrence, todayIn } from '@famos/time';
import { choreHref, type Rotation } from '../contract/index.ts';
import { choresView } from './capabilities.ts';
import { dueAfter } from './schedule.ts';
import { choreViews } from './shared.ts';
import { tables } from './store.ts';

/** How many turns of one chore a digest lists at most (a daily chore over two months). */
const MAX_TURNS = 62;

/** How far past the span the digest looks for the next turn. */
const NEXT_DAYS = 366;

export interface ChoreTurnsInput {
	nextDue: string | null;
	recurrence: Recurrence | null;
	startDate: string;
	rotation: Rotation;
	/** Whose turn it is now; null means anyone. */
	assigneeId: string | null;
	/** The people in turn order. */
	assigneeIds: readonly string[];
}

export interface ChoreTurn {
	date: string;
	/** Whose turn it is, or may be; empty: anyone's. */
	people: string[];
	overdue: boolean;
}

/**
 * The turns of a chore in `[from, to]`. The open turn is the one due now; it counts on its day,
 * or, when it is late and the span holds today, on the day it was due. Later turns follow its
 * repeat rule from after the open one (from after today when it is late: missed turns are skipped
 * once it is done). Who is up next is known for a fixed or round-robin rotation; with least done
 * it is whichever of them has done the fewest by then, so all of them are named.
 */
export function choreTurns(
	chore: ChoreTurnsInput,
	from: string,
	to: string,
	today: string,
): ChoreTurn[] {
	const first = chore.nextDue;
	if (first === null) return [];
	const order = chore.assigneeIds;
	const current = chore.assigneeId;
	const at = current ? order.indexOf(current) : -1;
	const whose = (k: number): string[] => {
		if (k === 0) return current ? [current] : [];
		if (order.length === 0) return [];
		if (chore.rotation === 'fixed') return current ? [current] : [order[0] as string];
		if (chore.rotation === 'round_robin')
			return [order[(at + k + order.length) % order.length] as string];
		return [...order];
	};
	const turns: ChoreTurn[] = [];
	const late = compareDates(first, today) < 0;
	const spanHoldsToday = compareDates(from, today) <= 0 && compareDates(today, to) <= 0;
	const inSpan = (date: string) => compareDates(date, from) >= 0 && compareDates(date, to) <= 0;
	if (inSpan(first) || (late && compareDates(first, from) < 0 && spanHoldsToday))
		turns.push({ date: first, people: whose(0), overdue: late });
	let cursor = late ? today : first;
	for (let k = 1; turns.length < MAX_TURNS; k++) {
		const next = dueAfter(chore.recurrence, chore.startDate, cursor);
		if (next === null || compareDates(next, to) > 0) break;
		if (compareDates(next, from) >= 0) turns.push({ date: next, people: whose(k), overdue: false });
		cursor = next;
	}
	return turns;
}

/**
 * The chores' turns in a span, for the people asked about (a turn anyone may take counts for
 * everyone), with what is late when the span holds today.
 */
export const choresDigest = defineDigest({
	id: 'chores.digest',
	topic: 'chores',
	title: 'Chore turns in some days, for an answer',
	description:
		'The turns of the household chores between two days: which chore, on which day, whose turn (on later turns, whose it will be), and what is late when the days include today.',
	requires: choresView.id,
	async run(uow, input) {
		const { timeZone } = await uow.family.settings();
		const today = todayIn(timeZone, uow.clock.now());
		const rows = await tables(uow.db)
			.selectFrom('chores_chores')
			.selectAll()
			.where('archived_at', 'is', null)
			.where('next_due', 'is not', null)
			.orderBy('next_due')
			.orderBy('title')
			.execute();
		const chores = await choreViews(uow.db, rows, today);
		const itemsIn = (from: string, to: string) =>
			chores
				.flatMap((chore) => {
					const notes = digestNotes(chore.notes);
					return choreTurns(chore, from, to, today)
						.filter((turn) => digestForPeople(turn.people, input.memberIds))
						.map(
							(turn): DigestItem => ({
								handle: chore.id,
								kind: 'chore',
								title: chore.title,
								date: turn.date,
								people: turn.people,
								...(notes && { notes }),
								...(turn.overdue && { status: 'overdue' as const }),
								...(chore.recurrence && { extra: { repeats: 'yes' } }),
								href: choreHref(chore.id),
							}),
						);
				})
				.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
		return digestOf(itemsIn(input.from, input.to), input, {
			async next() {
				const after = addDays(input.to, 1);
				return itemsIn(after, addDays(after, NEXT_DAYS))[0] ?? null;
			},
		});
	},
});
