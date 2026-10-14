import { formatClock, formatDate } from '@famos/time';
import type { PresenterContext } from '@famos/ui/slots';

/** What a change offered instead of a new event carries (`calendar.changeEvent` input). */
export interface OfferedChange {
	label?: string;
	date?: string;
	allDay?: boolean;
	startTime?: string;
}

/** A day and maybe a time, short, in the family's formats ("Sat 7 Nov 18:00"). */
export function when(date: string, time: string | undefined, c: PresenterContext): string {
	const day = formatDate(date, c.formatLocale, {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
	});
	return time ? `${day} ${formatClock(time, c.formatLocale, c.hourCycle)}` : day;
}

/**
 * What a new event's card says when it is an event already on the calendar: which event is there
 * and when, and the button that moves it to the new day and time instead.
 */
export function moveOffer(
	input: OfferedChange,
	at: { date: string; time?: string } | undefined,
	c: PresenterContext,
): { there: string; action: string } {
	const t = (key: string, options?: Record<string, unknown>) => c.t(`calendar:${key}`, options);
	const name = input.label || t('draft_an_event');
	return {
		there: t('draft_already_there', {
			what: at ? `${name} · ${when(at.date, at.time, c)}` : name,
		}),
		action: input.date
			? t('draft_move_instead', {
					when: when(input.date, input.allDay ? undefined : input.startTime, c),
				})
			: t('draft_change_instead'),
	};
}
