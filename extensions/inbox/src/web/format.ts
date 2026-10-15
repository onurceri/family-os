import type { AppContext } from '@famos/ui/app';

/** When a capture was made, in the family's region formats (never the UI language). */
export function captureTime(app: AppContext, at: number): string {
	return new Intl.DateTimeFormat(app.dateLocale(), {
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: app.hourCycle(),
		timeZone: app.timeZone(),
	}).format(at);
}
