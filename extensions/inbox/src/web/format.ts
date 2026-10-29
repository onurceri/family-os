import type { AppContext } from '@famos/ui/app';

/**
 * When a capture was made, in the family's region formats (never the UI language): "Thu 18:52",
 * or "Thu 6:52 PM" on a 12-hour clock, whose hour has no leading zero.
 */
export function captureTime(app: AppContext, at: number): string {
	return new Intl.DateTimeFormat(app.dateLocale(), {
		weekday: 'short',
		hour: app.hourCycle() === 'h12' ? 'numeric' : '2-digit',
		minute: '2-digit',
		hourCycle: app.hourCycle(),
		timeZone: app.timeZone(),
	}).format(at);
}
