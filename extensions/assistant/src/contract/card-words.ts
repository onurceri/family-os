import { addDays, formatClock, formatDate, type HourCycle, type SpanLabel } from '@famos/time';
import type { CardItem } from './index.ts';

/**
 * The words of an answer card that the server writes as plain lines and the app draws as rows:
 * days, clocks and the span, in the reader's language and date format.
 */

export interface CardWords {
	/** A key of the assistant's catalog in the reader's language. */
	t: (key: string, params?: Record<string, unknown>) => string;
	/** `dateLocale(language, formatLocale, hourCycle)`. */
	dateLocale: string;
	hourCycle: HourCycle;
	today: string;
}

const yearOf = (date: string) => date.slice(0, 4);

/** A weekday's name (1 = Monday) in the reader's language: 2026-01-05 was a Monday. */
export const weekdayName = (weekday: number, locale: string) =>
	formatDate(addDays('2026-01-05', weekday - 1), locale, { weekday: 'long' });

/** A day in words: weekday, day and month, and the year only when it is not this year. */
export function dayWords(date: string, words: CardWords, short = false): string {
	return formatDate(date, words.dateLocale, {
		weekday: short ? 'short' : 'long',
		day: 'numeric',
		month: short ? 'short' : 'long',
		...(yearOf(date) !== yearOf(words.today) && { year: 'numeric' }),
	});
}

export const clock = (time: string, words: CardWords) =>
	formatClock(time, words.dateLocale, words.hourCycle);

export const listOf = (names: readonly string[], locale: string) =>
	new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);

/** The span as the header names it ("This week, Mon 19 Oct – Sun 25 Oct"). */
export function spanLabel(span: SpanLabel, words: CardWords): string {
	return words.t(`span_${span.key}`, {
		date: dayWords(span.from, words),
		from: dayWords(span.from, words, true),
		to: dayWords(span.to, words, true),
	});
}

/** The span inside a sentence ("this weekend", "on Thursday 22 October"). */
export function spanPhrase(span: SpanLabel, words: CardWords): string {
	return words.t(`span_in_${span.key}`, {
		date: dayWords(span.from, words),
		from: dayWords(span.from, words, true),
		to: dayWords(span.to, words, true),
	});
}

/**
 * When an item happens ("Thursday 22 October, 16:30–17:15"). `sameDay` leaves its date out when
 * the card is about that one day. Nothing for what is late (its line says the day it was due) and
 * for a suggestion (its day is only what it is about).
 */
export function whenWords(item: CardItem, words: CardWords, sameDay: string | null): string {
	const { t } = words;
	if (!item.date || item.status === 'overdue' || item.kind === 'suggestion') return '';
	const time = item.time ? clock(item.time, words) : '';
	const endTime = item.endTime && !item.endDate ? clock(item.endTime, words) : '';
	const span = time && endTime ? t('card_time_range', { from: time, to: endTime }) : time;
	let when: string;
	if (item.date === sameDay) when = span;
	else
		when = span
			? t('card_date_time', { date: dayWords(item.date, words), time: span })
			: dayWords(item.date, words);
	if (item.endDate && item.endDate !== item.date)
		when = t('card_until', { when, date: dayWords(item.endDate, words) });
	return when;
}

/**
 * One item in words. `sameDay` leaves its date out when the card is about that one day; an item
 * that is late always says the day it was due.
 */
export function itemText(item: CardItem, words: CardWords, sameDay: string | null): string {
	const { t } = words;
	let what = item.title;
	if (item.kind === 'shopping_list' && item.detail)
		what = t('card_list', { name: what, things: item.detail });
	else if (item.kind === 'suggestion' && item.detail)
		what = t('card_group', { what, group: item.detail });
	else if (item.detail) what = t('card_detail', { what, detail: item.detail });
	if (item.place) what = t('card_place', { what, place: item.place });
	if (item.people.length > 0)
		what = t(item.kind === 'suggestion' ? 'card_from' : 'card_people', {
			what,
			people: listOf(item.people, words.dateLocale),
		});
	if (item.status === 'overdue' && item.date)
		what = t('card_overdue', { what, date: dayWords(item.date, words) });
	else if (item.status === 'failed') what = t('card_failed', { what });
	else if (item.kind === 'suggestion' && item.date)
		what = t('card_about_day', { what, date: dayWords(item.date, words) });
	if (item.forOthers) what = t('card_for_others', { what });
	const when = whenWords(item, words, sameDay);
	const line = when ? t('card_item', { when, what }) : what;
	return item.notes
		? t('card_notes', { what: line, notes: item.notes.replace(/\s+/g, ' ') })
		: line;
}

/** That the same days hold more for other people, and how many when the read was whole. */
export function othersLine(others: { count: number; more: boolean }, words: CardWords): string {
	return others.more
		? words.t('card_others_more')
		: words.t('card_others', { count: others.count });
}
