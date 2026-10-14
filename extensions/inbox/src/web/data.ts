import { type components, type paths, unwrap } from '@famos/api-client';
import type { FileLabel, InboxItem } from '../contract/index.js';
import { api } from './api.js';

/** Inbox and draft API calls, all through the generated client. */
export type Draft =
	paths['/api/v1/core/drafts']['get']['responses'][200]['content']['application/json'][number];
export type { components };

export const loadItems = async (): Promise<InboxItem[]> =>
	unwrap(await api.GET('/api/v1/inbox/items', { params: { query: { limit: 30 } } }));

export const loadPendingDrafts = async (): Promise<Draft[]> =>
	unwrap(
		await api.GET('/api/v1/core/drafts', { params: { query: { status: 'pending', limit: 200 } } }),
	);

/** Recent inbox drafts in every state, so decided ones still show under their item. */
export const loadInboxDrafts = async (): Promise<Draft[]> =>
	unwrap(
		await api.GET('/api/v1/core/drafts', {
			params: { query: { sourceKind: 'inbox', limit: 200 } },
		}),
	);

/** A record to file an item's files on, with a label for the papers (no AI involved). */
export interface FileChoice {
	recordId: string;
	recordKind: string;
	recordName: string;
	label: FileLabel;
}

export interface NewItem {
	channel: 'share' | 'upload' | 'text' | 'telegram' | 'email';
	title?: string;
	text?: string;
	url?: string;
	files?: readonly File[];
	fileTo?: FileChoice;
}

/** Multipart upload: text fields plus files. */
export async function sendItem(item: NewItem): Promise<InboxItem> {
	const { files = [], fileTo, ...rest } = item;
	const fields = {
		...rest,
		...(fileTo && {
			fileToRecordId: fileTo.recordId,
			fileToRecordKind: fileTo.recordKind,
			fileToRecordName: fileTo.recordName,
			fileToLabel: fileTo.label,
		}),
	};
	return unwrap(
		await api.POST('/api/v1/inbox/items', {
			body: fields,
			bodySerializer: (body) => {
				const form = new FormData();
				for (const [key, value] of Object.entries(body)) if (value) form.append(key, String(value));
				for (const file of files) form.append('files', file, file.name);
				return form;
			},
		}),
	);
}

export const retryItem = async (id: string) =>
	unwrap(await api.POST('/api/v1/actions/inbox.retryItem', { body: { id } }));

export const dismissItem = async (id: string) =>
	unwrap(await api.POST('/api/v1/actions/inbox.dismissItem', { body: { id } }));

export const fileItem = async (id: string, fileTo: FileChoice) =>
	unwrap(
		await api.POST('/api/v1/actions/inbox.fileItem', {
			body: {
				id,
				fileTo: {
					recordId: fileTo.recordId,
					recordKind: fileTo.recordKind,
					recordName: fileTo.recordName,
					label: fileTo.label,
				},
			},
		}),
	);

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

/** Turns a suggestion into the change it offers instead (moving the event already there). */
export const replaceDraft = async (draftId: string): Promise<Draft> =>
	unwrap(
		await api.POST('/api/v1/core/drafts/{draftId}/replace', { params: { path: { draftId } } }),
	);

export const fileUrl = (itemId: string, index: number) =>
	`/api/v1/inbox/items/${itemId}/files/${index}`;

/** What "Other ways in" says: whether Telegram and email reach Quick add (null: not known). */
export interface Ways {
	telegram: { available: boolean; linked: boolean; bot: string | null } | null;
	email: boolean | null;
}

export async function loadWays(): Promise<Ways> {
	const [telegram, email] = await Promise.allSettled([
		api.GET('/api/v1/telegram/link').then(unwrap),
		api.GET('/api/v1/email/available').then(unwrap),
	]);
	return {
		telegram:
			telegram.status === 'fulfilled'
				? {
						available: telegram.value.available,
						linked: telegram.value.linked,
						bot: telegram.value.botUsername,
					}
				: null,
		email: email.status === 'fulfilled' ? email.value.available : null,
	};
}
