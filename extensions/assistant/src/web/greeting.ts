/**
 * The words around a new conversation: the greeting by time of day, the suggestions under the
 * composer, and how long ago a conversation was used. Pure, so they are tested without a page.
 */

export type GreetingKey = 'greeting_morning' | 'greeting_afternoon' | 'greeting_evening';

/** Morning from 5 to 11, afternoon from 12 to 17, evening from 18 and through the night. */
export function greetingKey(hour: number): GreetingKey {
	if (hour >= 5 && hour < 12) return 'greeting_morning';
	if (hour >= 12 && hour < 18) return 'greeting_afternoon';
	return 'greeting_evening';
}

/** The hour (0 to 23) at `now` in the family's time zone. */
export function hourIn(timeZone: string, now: number = Date.now()): number {
	const parts = new Intl.DateTimeFormat('en', {
		timeZone,
		hour: 'numeric',
		hourCycle: 'h23',
		numberingSystem: 'latn',
	}).formatToParts(now);
	const hour = Number(parts.find((part) => part.type === 'hour')?.value);
	return Number.isFinite(hour) ? hour % 24 : new Date(now).getHours();
}

export type SuggestionArea = 'calendar' | 'shopping' | 'tasks' | 'list';

/** A suggestion card: its area (the icon), a short title and the question it sends. */
export type Suggestion = {
	area: SuggestionArea;
	title: `suggest_${SuggestionArea}`;
	question: `example_${SuggestionArea}`;
};

/** The four suggestions of a new conversation, one per area, in this order. */
export const SUGGESTIONS: readonly Suggestion[] = (
	['calendar', 'shopping', 'tasks', 'list'] as const
).map((area) => ({ area, title: `suggest_${area}`, question: `example_${area}` }));

/**
 * When a conversation was last used, in the UI language's words ("5 minutes ago", "yesterday"),
 * `justNow` within the minute, or the date (in the date locale) once it is a week old.
 */
export function usedAgo(
	ms: number,
	{ now = Date.now(), language, dateLocale, timeZone, justNow }: Ago,
): string {
	const seconds = Math.round((ms - now) / 1000);
	const abs = Math.abs(seconds);
	const words = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
	if (abs < 60) return justNow;
	if (abs < 3600) return words.format(Math.round(seconds / 60), 'minute');
	if (abs < 86_400) return words.format(Math.round(seconds / 3600), 'hour');
	if (abs < 7 * 86_400) return words.format(Math.round(seconds / 86_400), 'day');
	return new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeZone }).format(ms);
}

type Ago = {
	now?: number;
	language: string;
	dateLocale: string;
	timeZone: string;
	justNow: string;
};
