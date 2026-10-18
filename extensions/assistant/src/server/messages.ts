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

/** The answer card of a question, or null (none, or one this version cannot read). */
export function cardOf(row: Pick<MessageRow, 'card'>): AnswerCard | null {
	if (!row.card) return null;
	try {
		const parsed = AnswerCardSchema.safeParse(JSON.parse(row.card));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * The whole answer as words, for what has no cards: the model's words, the answer card as plain
 * lines and the app's line for each suggestion under them (a chat outside the app, the model's
 * own history, the summary).
 */
export const spokenText = (row: Pick<MessageRow, 'content' | 'suggested' | 'card'>): string =>
	[row.content, (cardOf(row)?.text ?? []).join('\n'), suggestedOf(row).join('\n')]
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
	status: row.status,
	errorCode: row.error_code,
	createdAt: row.created_at,
});
