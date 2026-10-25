import { defineAction } from '@famos/sdk';
import { daysAround, formatDate, resolveSpan, todayIn, weekOf, zoned } from '@famos/time';
import { z } from 'zod';

/**
 * Where "now" is for the family: the date, the weekday, the time and this week's first and last
 * day. An agent that never saw the server's instructions (an MCP client) cannot know the date,
 * and models count days badly, so they ask.
 */
export const today = defineAction({
	id: 'core.today',
	title: 'Today’s date, weekday and time in the family’s time zone',
	input: z.object({}),
	output: z.object({
		date: z.string().describe('Today, YYYY-MM-DD'),
		weekday: z.string(),
		time: z.string().describe('The time of day now, HH:MM (24-hour)'),
		timeZone: z.string(),
		weekFirstDay: z.string().describe('The first day of this week, YYYY-MM-DD'),
		weekLastDay: z.string().describe('The last day of this week, YYYY-MM-DD'),
		thisWeek: z
			.object({ from: z.string(), to: z.string() })
			.describe(
				'What "this week" means when someone asks: today to the week\u2019s last day, or the coming seven days when today is the last day. YYYY-MM-DD',
			),
		thisWeekNote: z
			.string()
			.nullable()
			.describe('Set when "this week" was asked on the week\u2019s last day'),
		nextWeek: z
			.object({ from: z.string(), to: z.string() })
			.describe('"Next week": the whole week after this one, YYYY-MM-DD'),
		days: z
			.array(z.string())
			.describe(
				'The days from a week ago to two weeks ahead, each with its weekday ("Tue 2026-10-13 (today)"). Take weekdays from here; when a weekday and a date disagree, say so and ask.',
			),
	}),
	readOnly: true,
	ai: {
		description:
			'Tells today’s date, the weekday, the time of day, the family time zone, the first and last day of this week (the week starts on the family’s first day of the week), and the weekday of each day from a week ago to two weeks ahead. Use it before turning "today", "tomorrow", "this week" or "next Friday" into dates.',
	},
	async run(uow) {
		const { timeZone, weekStart } = await uow.family.settings();
		const now = uow.clock.now();
		const date = todayIn(timeZone, now);
		const week = weekOf(date, weekStart);
		const thisWeek = resolveSpan({ kind: 'week' }, date, weekStart);
		const nextWeek = resolveSpan({ kind: 'next' }, date, weekStart);
		return {
			date,
			weekday: formatDate(date, 'en', { weekday: 'long' }),
			time: zoned(now, timeZone).toPlainTime().toString({ smallestUnit: 'minute' }),
			timeZone,
			weekFirstDay: week[0] as string,
			weekLastDay: week[6] as string,
			thisWeek: { from: thisWeek?.from ?? date, to: thisWeek?.to ?? (week[6] as string) },
			thisWeekNote:
				thisWeek?.label.key === 'coming_days'
					? 'Asked on the week\u2019s last day, "this week" means the coming seven days.'
					: null,
			nextWeek: { from: nextWeek?.from ?? date, to: nextWeek?.to ?? date },
			days: daysAround(date),
		};
	},
});
