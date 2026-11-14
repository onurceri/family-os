import { WEEKDAYS, type Weekday, weekdayOf } from '@famos/time';

/**
 * The weekly repeat days of a saved series whose start moves from `previousDate` to `nextDate`
 * with no new repeat rule sent: every day moves by the same number of weekdays, so "every
 * Tuesday and Thursday" moved one day on becomes Wednesday and Friday. A series whose start is
 * not on one of its days keeps them, and moving the start back shifts them back.
 */
export function weekdaysShiftedWithDate(
	byDay: readonly Weekday[],
	previousDate: string,
	nextDate: string,
): Weekday[] {
	if (!byDay.includes(weekdayOf(previousDate))) return [...byDay];
	const shift = WEEKDAYS.indexOf(weekdayOf(nextDate)) - WEEKDAYS.indexOf(weekdayOf(previousDate));
	return byDay.map((d) => WEEKDAYS[(WEEKDAYS.indexOf(d) + shift + 7) % 7] as Weekday);
}
