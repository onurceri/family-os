import { type JobContext, type LlmPolicy, QUESTION_TOPICS } from '@famos/sdk';
import { dateLocale, todayIn } from '@famos/time';
import { type AnswerCard, AnswerCardSchema, type Message } from '../contract/index.ts';
import { type CardWords, cardText, withoutPeople } from './card.ts';
import { withoutNames } from './scrub.ts';
import type { MessageRow } from './store.ts';
import { areaOf } from './tools.ts';

export type StoredToolCall = { name: string; ok: boolean; draftId?: string };

/** The app's lines for the suggestions of an answer (see `assistant_messages.suggested`). */
export function suggestedOf(row: Pick<MessageRow, 'suggested'>): string[] {
	if (!row.suggested) return [];
	try {
		return JSON.parse(row.suggested) as string[];
	} catch {
		return [];
	}
}

/** The column's text for the cards of an answer: one card as itself, several as a list. */
export const cardsColumn = (cards: readonly AnswerCard[]): string | null =>
	cards.length === 0 ? null : JSON.stringify(cards.length === 1 ? cards[0] : cards);

/** The answer cards of a message, in the order asked (none, or ones this version cannot read, are left out). */
export function cardsOf(row: Pick<MessageRow, 'card'>): AnswerCard[] {
	if (!row.card) return [];
	try {
		const stored: unknown = JSON.parse(row.card);
		return (Array.isArray(stored) ? stored : [stored]).flatMap((one) => {
			const parsed = AnswerCardSchema.safeParse(one);
			return parsed.success ? [parsed.data] : [];
		});
	} catch {
		return [];
	}
}

/** The first answer card of a message, or null. */
export const cardOf = (row: Pick<MessageRow, 'card'>): AnswerCard | null => cardsOf(row)[0] ?? null;

/**
 * The whole answer as words, for a person reading it where there are no cards: the model's
 * words, the answer card as plain lines and the app's line for each suggestion under them. What
 * a model reads of a stored message is `modelText`.
 */
export const spokenText = (row: Pick<MessageRow, 'content' | 'suggested' | 'card'>): string =>
	[
		row.content,
		cardsOf(row)
			.flatMap((card) => card.text)
			.join('\n'),
		suggestedOf(row).join('\n'),
	]
		.filter((part) => part !== '')
		.join('\n\n');

function toolCallsOf(row: Pick<MessageRow, 'tool_calls'>): StoredToolCall[] {
	if (!row.tool_calls) return [];
	try {
		return JSON.parse(row.tool_calls) as StoredToolCall[];
	} catch {
		return [];
	}
}

/**
 * What a model may be told now. A stored message was written under the settings of its day; it is
 * held to these, the ones in force when it is sent again.
 */
export interface ModelView {
	/** Names may reach the model (`LlmPolicy.sendPeople`). */
	sendPeople: boolean;
	/** The model may see data of this area now: open to the AI, local-only ones for a local model only. */
	open: (area: string) => boolean;
	/** No area is closed to this model: what came from an area not known can be told too. */
	noneClosed: boolean;
	/** The family's names, written as `someone` in the app's and the model's own words when names are not sent. */
	names: readonly string[];
	someone: string;
	/** For writing a card again without its people, or without topics the model may not see now. */
	words: CardWords;
}

/** The view for a model the policy describes, with cards written in `locale` (else the family's language). */
export async function modelView(
	ctx: Pick<JobContext, 'actions' | 'family' | 'translate' | 'clock'>,
	policy: Pick<LlmPolicy, 'sendPeople' | 'local'>,
	locale: string | null,
): Promise<ModelView> {
	const settings = await ctx.family.settings();
	const language = locale ?? settings.locale;
	const missing = ctx.actions.aiMissingAreas({ local: policy.local });
	const closed = new Set(missing.map((m) => m.id));
	return {
		sendPeople: policy.sendPeople,
		open: (area) => !closed.has(area),
		noneClosed: missing.every((m) => m.why !== 'closed_to_ai'),
		names: (await ctx.family.members()).map((m) => m.displayName),
		someone: ctx.translate(language, 'assistant:someone'),
		words: {
			t: (key, params) => ctx.translate(language, `assistant:${key}`, params),
			dateLocale: dateLocale(language, settings.formatLocale, settings.hourCycle),
			hourCycle: settings.hourCycle,
			today: todayIn(settings.timeZone, ctx.clock.now()),
		},
	};
}

/** Core is no area: what it holds is governed by the privacy switches. */
const areasIn = (areas: Iterable<string>): string[] =>
	[...new Set(areas)].filter((a) => a !== 'core');

const cardAreas = (card: Pick<AnswerCard, 'sections'>) =>
	areasIn(card.sections.map((s) => QUESTION_TOPICS[s.topic]));

/** The areas whose data a stored answer carries: the topics of its cards and the tools it used. */
export function areasOf(row: Pick<MessageRow, 'card' | 'tool_calls'>): string[] {
	return areasIn([
		...cardsOf(row).flatMap(cardAreas),
		...toolCallsOf(row).map((call) => areaOf(call.name)),
	]);
}

/** Text for a model, and the areas whose data it carries (to name in the call). */
export interface ModelText {
	text: string;
	areas: string[];
}

/**
 * A stored message as a model may read it now. The person's own words go as written. An answer's
 * cards show only the topics of areas the model may see, and no people when names are not sent;
 * its words and suggestion lines carry the data of every area it drew on, so they are left out
 * when one of those is closed now, and when names are not sent the family's names in them are
 * written as `someone`.
 */
export function modelText(
	row: Pick<MessageRow, 'role' | 'content' | 'suggested' | 'card' | 'tool_calls'>,
	view: ModelView,
): ModelText {
	if (row.role === 'user') return { text: row.content, areas: [] };
	const own = (text: string) =>
		view.sendPeople ? text : withoutNames(text, view.names, view.someone);
	const used = areasOf(row);
	const spoken = used.every(view.open);
	const cards = cardsOf(row).map((card) => {
		const sections = card.sections.filter((s) => {
			const area = QUESTION_TOPICS[s.topic];
			return area === 'core' || view.open(area);
		});
		if (view.sendPeople && sections.length === card.sections.length) return card;
		const shown = { ...card, sections };
		return {
			...shown,
			text: cardText(view.sendPeople ? shown : withoutPeople(shown), view.words),
		};
	});
	return {
		text: [
			spoken ? own(row.content) : '',
			cards.flatMap((card) => card.text).join('\n'),
			spoken ? own(suggestedOf(row).join('\n')) : '',
		]
			.filter((part) => part !== '')
			.join('\n\n'),
		areas: spoken ? used : areasIn(cards.flatMap(cardAreas)),
	};
}

/**
 * The thread's summary as a model may read it now. It may hold anything the messages it covers
 * held, so it is left out when one of them drew on an area closed now; when names are not sent,
 * the family's names in it are written as `someone`.
 */
export function modelSummary(
	summary: string | null,
	covered: readonly Pick<MessageRow, 'card' | 'tool_calls'>[],
	view: ModelView,
): ModelText | null {
	if (!summary) return null;
	const areas = areasIn(covered.flatMap(areasOf));
	if (!areas.every(view.open)) return null;
	return {
		text: view.sendPeople ? summary : withoutNames(summary, view.names, view.someone),
		areas,
	};
}

export const toMessage = (row: MessageRow): Message => ({
	id: row.id,
	role: row.role,
	content: row.content,
	toolCalls: toolCallsOf(row),
	suggested: suggestedOf(row),
	card: cardOf(row),
	cards: cardsOf(row),
	status: row.status,
	errorCode: row.error_code,
	createdAt: row.created_at,
});
