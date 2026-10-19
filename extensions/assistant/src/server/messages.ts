import { type AnswerCard, AnswerCardSchema, type Message } from '../contract/index.ts';
import type { MessageRow } from './store.ts';

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
 * The whole answer as words, for what has no cards: the model's words, the answer card as plain
 * lines and the app's line for each suggestion under them (a chat outside the app, the model's
 * own history, the summary).
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
