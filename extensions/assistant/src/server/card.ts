import type { DigestItem, DigestOutput, QuestionTopic } from '@famos/sdk';
import type { SpanLabel } from '@famos/time';
import {
	type CardWords,
	dayWords,
	itemText,
	listOf,
	othersLine,
	spanLabel,
	spanPhrase,
	weekdayName,
} from '../contract/card-words.ts';
import type { AnswerCard, CardItem } from '../contract/index.ts';

export type { CardWords };

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
		...(item.href && { href: item.href }),
	};
}

export interface Fetched {
	topic: QuestionTopic;
	output: DigestOutput;
	/** When the question was about some people: what the same days hold for the others. */
	others?: { count: number; more: boolean } | undefined;
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
		sections: parts.fetched.map(({ topic, output, others }) => ({
			topic,
			items: output.items.map((item) => cardItem(item, parts.names)),
			truncated: output.truncated,
			...(output.hidden !== undefined && { hidden: output.hidden }),
			...(output.nextAfter && { next: cardItem(output.nextAfter, parts.names) }),
			...(others && { others: { ...others } }),
		})),
		notHere: [...parts.notHere],
	};
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
		lines.push(
			t('card_unmatched', {
				count: understood.unmatched.length,
				names: listOf(understood.unmatched, words.dateLocale),
			}),
		);
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
		if (section.others) lines.push(othersLine(section.others, words));
	}
	if (card.notHere.length > 0) lines.push('');
	for (const missing of card.notHere)
		lines.push(t(`card_${missing.why}`, { topic: t(`topic_${missing.topic}`) }));
	return lines;
}
