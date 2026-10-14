import { addDays, formatDate, Temporal } from '@famos/time';

/**
 * Date help for the model. Models miscount weekdays and rarely notice that "next Thursday" has
 * two readings, so the prompt carries a ready-made calendar; whether a chosen date is a guess is
 * decided in code (`isUncertainDate` in `@famos/time`) from the words the model quotes.
 */

/** The next 14 days with weekday names and week labels (weeks start on `weekStart`), for the prompt. */
export function dateTable(today: string, weekStart = 1): string {
	const monday = (date: string) => {
		const d = Temporal.PlainDate.from(date);
		return d.subtract({ days: (d.dayOfWeek - weekStart + 7) % 7 }).toString();
	};
	const thisWeek = monday(today);
	const lines: string[] = [];
	for (let i = 0; i < 15; i++) {
		const date = addDays(today, i);
		const weeks = Math.round(Temporal.PlainDate.from(thisWeek).until(monday(date)).days / 7);
		const week = weeks === 0 ? 'this week' : weeks === 1 ? 'next week' : 'the week after';
		const label = i === 0 ? 'today' : i === 1 ? 'tomorrow' : week;
		lines.push(`- ${formatDate(date, 'en', { weekday: 'long' })} ${date} (${label})`);
	}
	return lines.join('\n');
}

/** Top-level input fields that hold dates (`date`, `dueDate`, `endDate`, …). */
export function datePaths(input: Record<string, unknown>): string[] {
	return Object.keys(input).filter((key) => /date$/i.test(key) && typeof input[key] === 'string');
}
