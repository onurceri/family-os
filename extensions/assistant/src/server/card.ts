import type { DigestItem, DigestOutput, QuestionTopic } from '@famos/sdk';
import { addDays, formatClock, formatDate, type HourCycle, type SpanLabel } from '@famos/time';
import type { AnswerCard, CardItem } from '../contract/index.ts';

/**
 * The answer card of a question, made by code from the digests: every fact on it is what an
 * area holds, written in the reader's language and date format. Nothing here asks a model.
 */

/** What stands over days instead of happening on one: its digest day is only the span's first. */
const STANDING = new Set<DigestItem['kind']>(['shopping_list', 'note', 'suggestion']);

const TYPED_ID =
	/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A digest item as the card keeps it: people by name, no ids. */
export function cardItem(item: DigestItem, names: ReadonlyMap<string, string>): CardItem {
	const extra = item.extra ?? {};
	const clean = (value: string | undefined) =>
		value !== undefined && value.trim() !== '' && !TYPED_ID.test(value) ? value : undefined;
	const detail =
		item.kind === 'duty'
			? clean(extra.record)
			: item.kind === 'shopping_list'
				? clean(extra.things)
				: item.kind === 'suggestion'
					? clean(extra.group)
					: undefined;
	const day = item.kind === 'suggestion' ? clean(extra.day) : undefined;
	// A task with no due date stands on the span's first day only to be in it.
	const standing = STANDING.has(item.kind) || extra.undated === 'yes';
	const date = standing ? day : item.date;
	const place = item.kind === 'event' ? clean(extra.location) : undefined;
	return {
		kind: item.kind,
		title: item.title,
		...(date && { date }),
		...(item.time && !standing && { time: item.time }),
		...(item.end?.date && { endDate: item.end.date }),
		...(item.end?.time && { endTime: item.end.time }),
		...(item.allDay && { allDay: true }),
		people: item.people.map((id) => names.get(id)).filter((n): n is string => n !== undefined),
		...(item.notes && { notes: item.notes }),
		...(item.status && { status: item.status }),
		...(place && { place }),
		...(detail && { detail }),
		...(item.kind === 'suggestion' && extra.waitsFor === 'others' && { forOthers: true }),
	};
}

export interface Fetched {
	topic: QuestionTopic;
	output: DigestOutput;
}

export interface CardParts {
	topics: readonly QuestionTopic[];
	people: readonly string[];
	everyone: boolean;
	unmatched: readonly string[];
	span: SpanLabel;
	fallback: boolean;
	/** Weekdays the person wrote next to a date of another weekday (1 = Monday). */
	mismatches?: readonly { date: string; said: number }[];
	fetched: readonly Fetched[];
	notHere: AnswerCard['notHere'];
	names: ReadonlyMap<string, string>;
}

/** The card's facts, without the plain lines and the lead (see `cardText`, `checkLead`). */
export function buildCard(parts: CardParts): Omit<AnswerCard, 'text' | 'lead'> {
	return {
		understood: {
			topics: [...parts.topics],
			people: [...parts.people],
			everyone: parts.everyone,
			unmatched: [...parts.unmatched],
			span: { ...parts.span },
			fallback: parts.fallback,
			...(parts.mismatches?.length && { mismatches: [...parts.mismatches] }),
		},
		sections: parts.fetched.map(({ topic, output }) => ({
			topic,
			items: output.items.map((item) => cardItem(item, parts.names)),
			truncated: output.truncated,
			...(output.hidden !== undefined && { hidden: output.hidden }),
			...(output.nextAfter && { next: cardItem(output.nextAfter, parts.names) }),
		})),
		notHere: [...parts.notHere],
	};
}

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
const weekdayName = (weekday: number, locale: string) =>
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

const clock = (time: string, words: CardWords) =>
	formatClock(time, words.dateLocale, words.hourCycle);

const listOf = (names: readonly string[], locale: string) =>
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
	let when = '';
	if (item.date && item.status !== 'overdue' && item.kind !== 'suggestion') {
		const time = item.time ? clock(item.time, words) : '';
		const endTime = item.endTime && !item.endDate ? clock(item.endTime, words) : '';
		const span = time && endTime ? t('card_time_range', { from: time, to: endTime }) : time;
		if (item.date === sameDay) when = span;
		else
			when = span
				? t('card_date_time', { date: dayWords(item.date, words), time: span })
				: dayWords(item.date, words);
		if (item.endDate && item.endDate !== item.date)
			when = t('card_until', { when, date: dayWords(item.endDate, words) });
	}
	const line = when ? t('card_item', { when, what }) : what;
	return item.notes
		? t('card_notes', { what: line, notes: item.notes.replace(/\s+/g, ' ') })
		: line;
}

/** The card as plain lines: the header, each topic with its facts, then what is not here. */
export function cardText(card: Omit<AnswerCard, 'text' | 'lead'>, words: CardWords): string[] {
	const { t } = words;
	const { understood } = card;
	const sameDay = understood.span.from === understood.span.to ? understood.span.from : null;
	const header = [
		listOf(
			understood.topics.map((topic) => t(`topic_${topic}`)),
			words.dateLocale,
		),
		...(understood.everyone
			? [t('card_everyone')]
			: understood.people.length > 0
				? [listOf(understood.people, words.dateLocale)]
				: []),
		spanLabel(understood.span, words),
	].filter((part) => part !== '');
	const lines = [header.join(' · ')];
	for (const slip of understood.mismatches ?? [])
		lines.push(
			t('card_weekday_slip', {
				date: dayWords(slip.date, words),
				said: weekdayName(slip.said, words.dateLocale),
			}),
		);
	if (understood.unmatched.length > 0)
		lines.push(t('card_unmatched', { names: listOf(understood.unmatched, words.dateLocale) }));
	for (const section of card.sections) {
		lines.push('', t(`topic_${section.topic}`));
		if (section.items.length === 0) {
			const span = spanPhrase(understood.span, words);
			lines.push(
				section.next
					? t('card_nothing_next', { span, next: itemText(section.next, words, null) })
					: t('card_nothing', { span }),
			);
		}
		for (const item of section.items) lines.push(`- ${itemText(item, words, sameDay)}`);
		if (section.truncated) lines.push(t('card_more'));
		if (section.hidden) lines.push(t('card_hidden', { count: section.hidden }));
	}
	if (card.notHere.length > 0) lines.push('');
	for (const missing of card.notHere)
		lines.push(t(`card_${missing.why}`, { topic: t(`topic_${missing.topic}`) }));
	return lines;
}
