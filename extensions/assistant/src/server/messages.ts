import type { Message } from '../contract/index.ts';
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

/**
 * The whole answer as words, for what has no cards: the model's words with the app's line for
 * each suggestion under them (a chat outside the app, the model's own history, the summary).
 */
export const spokenText = (row: Pick<MessageRow, 'content' | 'suggested'>): string =>
	[row.content, suggestedOf(row).join('\n')].filter((part) => part !== '').join('\n\n');

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
	status: row.status,
	errorCode: row.error_code,
	createdAt: row.created_at,
});
