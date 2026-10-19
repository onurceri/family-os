import {
	type CardWords,
	dayWords,
	itemText,
	listOf,
	othersLine,
	spanLabel,
	spanPhrase,
	weekdayName,
	whenWords,
} from '../contract/card-words.js';
import type { AnswerCard, CardItem } from '../contract/index.js';

/** A path inside the app: one slash first, no second slash, no space or backslash. */
const APP_PATH = /^\/(?!\/)[^\s\\]*$/;

/** The item's link when it is a path inside the app, else null (a row then stays plain). */
export const rowHref = (item: Pick<CardItem, 'href'>): string | null =>
	item.href && item.href.length <= 300 && APP_PATH.test(item.href) ? item.href : null;

/**
 * An answer card as the thread draws it: every line already in words, so the component only
 * lays them out. The facts are the stored card's; nothing here asks the server for more.
 */

export interface RowView {
	/** The day and time ("Thursday 22 October, 16:30–17:15"), or "" when the card is about that day. */
	when: string;
	title: string;
	/** Where it is, what it is for: the facts after the title. */
	facts: string[];
	/** What is wrong with it or what it waits for, in state text. */
	state: string[];
	people: string[];
	notes: string;
	/** Where tapping the row goes; null: the row is plain. */
	href: string | null;
}

export interface SectionView {
	topic: string;
	label: string;
	rows: RowView[];
	/** "Nothing this weekend; next: …" for a topic with no items in the days. */
	empty: string | null;
	/** "And more." when the topic has more than it shows. */
	more: string | null;
	/** The items the assistant may not read. */
	hidden: string | null;
	/** "2 more are for other people." when the question was about some people. */
	others: string | null;
}

export interface CardView {
	/** The topics, people and span as the question was understood. */
	understood: string[];
	/** A weekday that did not fit its date, and names nobody has. */
	notices: string[];
	sections: SectionView[];
	/** The topics that cannot be answered here, each with its reason. */
	notHere: string[];
}

export function rowView(item: CardItem, words: CardWords, sameDay: string | null): RowView {
	const { t } = words;
	const state: string[] = [];
	if (item.status === 'overdue' && item.date)
		state.push(t('card_state_overdue', { date: dayWords(item.date, words) }));
	else if (item.status === 'failed') state.push(t('card_state_failed'));
	else if (item.kind === 'suggestion' && item.date)
		state.push(t('card_state_about_day', { date: dayWords(item.date, words) }));
	if (item.forOthers) state.push(t('card_state_for_others'));
	const facts = [item.place, item.detail].filter((fact): fact is string => Boolean(fact));
	return {
		when: whenWords(item, words, sameDay),
		title: item.title,
		facts,
		state,
		people: item.people,
		notes: (item.notes ?? '').replace(/\s+/g, ' ').trim(),
		href: rowHref(item),
	};
}

export function cardView(card: AnswerCard, words: CardWords): CardView {
	const { t } = words;
	const { understood } = card;
	const sameDay = understood.span.from === understood.span.to ? understood.span.from : null;
	const people = understood.everyone
		? [t('card_everyone')]
		: understood.people.length > 0
			? [listOf(understood.people, words.dateLocale)]
			: [];
	const notices = [
		...(understood.mismatches ?? []).map((slip) =>
			t('card_weekday_slip', {
				date: dayWords(slip.date, words),
				said: weekdayName(slip.said, words.dateLocale),
			}),
		),
		...(understood.unmatched.length > 0
			? [
					t('card_unmatched', {
						count: understood.unmatched.length,
						names: listOf(understood.unmatched, words.dateLocale),
					}),
				]
			: []),
	];
	return {
		understood: [
			listOf(
				understood.topics.map((topic) => t(`topic_${topic}`)),
				words.dateLocale,
			),
			...people,
			spanLabel(understood.span, words),
		].filter((part) => part !== ''),
		notices,
		sections: card.sections.map((section) => {
			const span = spanPhrase(understood.span, words);
			return {
				topic: section.topic,
				label: t(`topic_${section.topic}`),
				rows: section.items.map((item) => rowView(item, words, sameDay)),
				empty:
					section.items.length > 0
						? null
						: section.next
							? t('card_nothing_next', { span, next: itemText(section.next, words, null) })
							: t('card_nothing', { span }),
				more: section.truncated ? t('card_more') : null,
				hidden: section.hidden ? t('card_hidden', { count: section.hidden }) : null,
				others: section.others ? othersLine(section.others, words) : null,
			};
		}),
		notHere: card.notHere.map((missing) =>
			t(`card_${missing.why}`, { topic: t(`topic_${missing.topic}`) }),
		),
	};
}

/** A member's colour for a name on a card, or null when no one or more than one has the name. */
export function colorOf(
	name: string,
	members: readonly { displayName: string; color: string }[],
): string | null {
	const named = members.filter((member) => member.displayName === name);
	return named.length === 1 ? (named[0]?.color ?? null) : null;
}
