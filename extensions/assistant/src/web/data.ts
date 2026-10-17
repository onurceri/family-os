import { type paths, unwrap } from '@famos/api-client';
import type { Message, Thread, ThreadDetail } from '../contract/index.js';
import { api } from './api.js';

/** Assistant API calls, all through the generated client. */
export const loadThreads = async (): Promise<Thread[]> =>
	unwrap(await api.GET('/api/v1/assistant/threads'));

export const loadThread = async (threadId: string): Promise<ThreadDetail> =>
	unwrap(
		await api.GET('/api/v1/assistant/threads/{threadId}', { params: { path: { threadId } } }),
	) as ThreadDetail;

export async function sendMessage(
	text: string,
	threadId?: string,
): Promise<{ threadId: string; messageId: string; replyId: string }> {
	const result = unwrap(
		await api.POST('/api/v1/actions/assistant.sendMessage', {
			body: {
				text,
				...(threadId && { threadId }),
			},
		}),
	);
	if (result.status !== 'applied') throw new Error('The message was not sent');
	return result.output as { threadId: string; messageId: string; replyId: string };
}

export const deleteThread = async (id: string): Promise<void> => {
	unwrap(await api.POST('/api/v1/actions/assistant.deleteThread', { body: { id } }));
};

/** Whether an answer is still being written. */
export const isOpen = (message: Message) =>
	message.status === 'pending' || message.status === 'streaming';

export const renameThread = async (id: string, title: string): Promise<void> => {
	unwrap(await api.POST('/api/v1/actions/assistant.renameThread', { body: { id, title } }));
};

/** A draft as the Inbox shows it. */
export type Draft =
	paths['/api/v1/core/drafts']['get']['responses'][200]['content']['application/json'][number];

/** The drafts one answer created: a turn's drafts are tied to the answer message. */
export const loadAnswerDrafts = async (
	messageId: string,
	ids: readonly string[],
): Promise<Draft[]> =>
	unwrap(
		await api.GET('/api/v1/core/drafts', {
			params: { query: { sourceKind: 'assistant', sourceId: messageId, limit: 50 } },
		}),
	)
		.filter((draft) => ids.includes(draft.id))
		.toSorted((a, b) => a.createdAt - b.createdAt);

export const approveDraft = async (draftId: string, input?: unknown): Promise<Draft> =>
	unwrap(
		await api.POST('/api/v1/core/drafts/{draftId}/approve', {
			params: { path: { draftId } },
			body: input === undefined ? {} : { input },
		}),
	);

export const rejectDraft = async (draftId: string): Promise<Draft> =>
	unwrap(await api.POST('/api/v1/core/drafts/{draftId}/reject', { params: { path: { draftId } } }));

export const undoDraft = async (draftId: string): Promise<Draft> =>
	unwrap(await api.POST('/api/v1/core/drafts/{draftId}/undo', { params: { path: { draftId } } }));

/** Sends a suggestion that was taken back again, as a new one waiting for approval. */
export const suggestDraftAgain = async (draftId: string): Promise<Draft> =>
	unwrap(
		await api.POST('/api/v1/core/drafts/{draftId}/suggest-again', {
			params: { path: { draftId } },
		}),
	);

/** Turns a suggestion into the change it offers instead (moving the event already there). */
export const replaceDraft = async (draftId: string): Promise<Draft> =>
	unwrap(
		await api.POST('/api/v1/core/drafts/{draftId}/replace', { params: { path: { draftId } } }),
	);
