import { unwrap } from '@famos/api-client';
import { todayIn } from '@famos/time';
import type { AppContext } from '@famos/ui/app';
import { sharedRead } from '@famos/ui/famos';
import type { Forecast } from '../contract/index.js';
import { type SentenceItem, weatherSentence } from '../contract/sentence.js';
import { api } from './api.js';
import type { AmbientT } from './i18n.js';

/**
 * The day's timed items for the weather sentence, read through the calendar's own route (titles
 * and starts only). Empty when the person or display may not see the calendar.
 */
export async function loadTimedItems(app: AppContext, now = Date.now()): Promise<SentenceItem[]> {
	if (!app.can('calendar.view')) return [];
	const day = todayIn(app.timeZone(), now);
	// The same read as the calendar's own (Today's timeline), so they share it.
	const occurrences = await sharedRead(
		`/api/v1/calendar/occurrences?from=${day}&to=${day}`,
		async () =>
			unwrap(
				await api.GET('/api/v1/calendar/occurrences', {
					params: { query: { from: day, to: day } },
				}),
			),
	);
	return occurrences.flatMap((o) =>
		!o.allDay && o.start !== null ? [{ title: o.title, start: o.start }] : [],
	);
}

/** The weather sentence as text in the person's language, or null when there is nothing to say. */
export function sayWeather(
	forecast: Forecast,
	items: readonly SentenceItem[],
	now: number,
	app: AppContext,
	t: AmbientT,
): string | null {
	const sentence = weatherSentence(forecast, items, now, {
		timeZone: app.timeZone(),
		formatLocale: app.formatLocale(),
		dateLocale: app.dateLocale(),
		hourCycle: app.hourCycle(),
	});
	if (!sentence) return null;
	return t(sentence.key, {
		...sentence.params,
		...(sentence.label && { label: t(sentence.label) }),
	});
}
