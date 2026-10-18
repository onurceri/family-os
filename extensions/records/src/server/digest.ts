import {
	type DigestInput,
	DigestInputSchema,
	type DigestItem,
	type DigestOutput,
	DigestOutputSchema,
	defineAction,
	defineDigest,
	digestForPeople,
	digestNotes,
	digestOf,
	type UnitOfWork,
} from '@famos/sdk';
import { addDays, compareDates, todayIn } from '@famos/time';
import { z } from 'zod';
import { recordsView } from './capabilities.ts';
import { aiMayRead, openUntil } from './obligations.ts';
import { fromRule, nextDue } from './recurrence.ts';
import { type ObligationRow, tables } from './store.ts';

/** How far past the span a duties digest looks for the next one. */
const NEXT_DAYS = 366;

/** How many dates of one repeating duty a digest lists at most. */
const MAX_DATES = 12;

/**
 * The days a duty is due in `[from, to]`: its open due date, then the later dates of its repeat.
 * A duty still open from before the span counts on the day it was due when the span holds today;
 * a date that only passes (a warranty ends) is never late.
 */
export function dutyDueDays(
	duty: Pick<ObligationRow, 'due_date' | 'rrule' | 'rrule_start' | 'lapses'>,
	from: string,
	to: string,
	today: string,
): string[] {
	const due = duty.due_date;
	const days: string[] = [];
	const inSpan = compareDates(due, from) >= 0 && compareDates(due, to) <= 0;
	const late =
		duty.lapses === 0 &&
		compareDates(due, from) < 0 &&
		compareDates(due, today) < 0 &&
		compareDates(from, today) <= 0 &&
		compareDates(today, to) <= 0;
	if (inSpan || late) days.push(due);
	const every = fromRule(duty.rrule);
	if (!every) return days;
	const anchor = duty.rrule_start ?? due;
	let cursor = compareDates(due, from) >= 0 ? due : addDays(from, -1);
	while (days.length < MAX_DATES) {
		const next = nextDue(anchor, every, cursor);
		if (compareDates(next, to) > 0) break;
		if (compareDates(next, due) > 0 && compareDates(next, from) >= 0) days.push(next);
		cursor = next;
	}
	return days;
}

const dutyItem = (row: ObligationRow, date: string, today: string): DigestItem => {
	const notes = digestNotes(row.notes);
	return {
		handle: row.id,
		kind: 'duty',
		title: row.title,
		date,
		people: row.assignee_id ? [row.assignee_id] : [],
		...(notes && { notes }),
		...(date === row.due_date &&
			row.lapses === 0 &&
			compareDates(date, today) < 0 && { status: 'overdue' as const }),
		extra: {
			// What it is for, by name; the record itself becomes a handle.
			record: row.record_name,
			recordId: row.record_id,
			...(row.lapses === 1 && { ends: 'yes' }),
			...(row.rrule && { repeats: 'yes' }),
		},
	};
};

/**
 * The duties due in a span, of every record or of some kinds of record, as a digest. A duty
 * belongs to the area of its audience (a pet's, a vehicle's): the AI reads only those of areas it
 * may use, and counts the others as hidden.
 */
export async function dutiesDigest(
	uow: UnitOfWork,
	input: DigestInput,
	recordKinds?: readonly string[],
): Promise<DigestOutput> {
	const { timeZone } = await uow.family.settings();
	const today = todayIn(timeZone, uow.clock.now());
	let query = openUntil(tables(uow.db), today);
	if (recordKinds && recordKinds.length > 0)
		query = query.where('record_kind', 'in', [...recordKinds]);
	const rows = (await query.orderBy('due_date').orderBy('created_at').execute()).filter((row) =>
		digestForPeople(row.assignee_id ? [row.assignee_id] : [], input.memberIds),
	);
	const readable = rows.filter((row) => aiMayRead(uow, row.audience));
	const itemsIn = (from: string, to: string, among: readonly ObligationRow[]) =>
		among
			.flatMap((row) => dutyDueDays(row, from, to, today).map((day) => dutyItem(row, day, today)))
			.sort((a, b) => a.date.localeCompare(b.date));
	const hidden = itemsIn(
		input.from,
		input.to,
		rows.filter((row) => !readable.includes(row)),
	).length;
	return digestOf(itemsIn(input.from, input.to, readable), input, {
		hidden,
		async next() {
			const after = addDays(input.to, 1);
			const later = readable
				.flatMap((row) => {
					const [day] = dutyDueDays(row, after, addDays(after, NEXT_DAYS), today);
					return day ? [dutyItem(row, day, today)] : [];
				})
				.sort((a, b) => a.date.localeCompare(b.date));
			return later[0] ?? null;
		},
	});
}

/** Every duty of the household that is due in the span, whatever record it is for. */
export const recordsDigest = defineDigest({
	id: 'records.digest',
	topic: 'records',
	title: 'Duties due in some days, for an answer',
	description:
		'The duties of the household due between two days (inspection, insurance, vaccination, service, a warranty that ends), with the record each is for, who does it, and what is late when the days include today.',
	requires: recordsView.id,
	run: (uow, input) => dutiesDigest(uow, input),
});

/**
 * The same for some kinds of record, for the areas that own them (the pets' digest asks for the
 * pets' duties). Not offered to the AI itself: each area's digest is.
 */
export const dueBetween = defineAction({
	id: 'records.dueBetween',
	title: 'Duties of some kinds of record due in some days',
	input: z.object({
		span: DigestInputSchema,
		recordKinds: z.array(z.string().min(1).max(40)).min(1).max(10),
	}),
	output: DigestOutputSchema,
	readOnly: true,
	requires: recordsView.id,
	run: (uow, { span, recordKinds }) => dutiesDigest(uow, span, recordKinds),
});
