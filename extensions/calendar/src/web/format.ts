import { formatClock, formatDate, formatTime, type HourCycle } from '@famos/time';

/** Display helpers. Dates are `YYYY-MM-DD`; instants are epoch ms shown in the family zone. */
export function timeLabel(
	ms: number,
	timeZone: string,
	locale: string,
	hourCycle?: HourCycle,
): string {
	return formatTime(ms, timeZone, locale, hourCycle);
}

export interface WhenInput {
	allDay?: boolean | undefined;
	date: string;
	endDate?: string | null | undefined;
	startTime?: string | null | undefined;
	endTime?: string | null | undefined;
}

export function describeWhen(
	input: WhenInput,
	locale: string,
	allDayLabel: string,
	hourCycle?: HourCycle,
	// A draft card writes its days its own way, so every card shows one format.
	dayOf: (date: string) => string = (date) => formatDate(date, locale),
): string {
	const day = dayOf(input.date);
	if (input.allDay) {
		return input.endDate && input.endDate !== input.date
			? `${day} – ${dayOf(input.endDate)} · ${allDayLabel}`
			: `${day} · ${allDayLabel}`;
	}
	const clock = (time: string) => formatClock(time, locale, hourCycle);
	return `${day}, ${input.startTime ? clock(input.startTime) : ''}${input.endTime ? `–${clock(input.endTime)}` : ''}`;
}
