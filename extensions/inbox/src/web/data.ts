import { type components, type Draft, draftClient, unwrap } from '@famos/api-client';
import type { FileLabel, InboxItem } from '../contract/index.js';
import { api } from './api.js';

/** Inbox and draft API calls, all through the generated client. */
export type { components, Draft };

export const loadItems = async (): Promise<InboxItem[]> =>
	unwrap(await api.GET('/api/v1/inbox/items', { params: { query: { limit: 30 } } }));

const loadDrafts = async (status: 'pending' | 'failed'): Promise<Draft[]> =>
	unwrap(await api.GET('/api/v1/core/drafts', { params: { query: { status, limit: 200 } } }));

/**
 * The suggestions that still wait for a decision: pending ones, and those whose applying failed
 * and can be tried again. Each says whether the signed-in person may decide it (`canDecide`).
 */
export const loadWaitingDrafts = async (): Promise<Draft[]> =>
	(await Promise.all([loadDrafts('pending'), loadDrafts('failed')])).flat();

/**
 * The newest suggestions in every state that the signed-in person may see: theirs, and those they
 * may decide. Quick add finds the person's own decided requests among them.
 */
export const loadRecentDrafts = async (): Promise<Draft[]> =>
	unwrap(await api.GET('/api/v1/core/drafts', { params: { query: { limit: 200 } } }));

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

/** The draft calls (approve, reject, undo, edit, suggest again, replace). */
export const draftCalls = draftClient(api);

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

/** Whether the AI can read what is added (null: not known, as when the answer failed). */
export async function loadAiReading(): Promise<boolean | null> {
	try {
		return unwrap(await api.GET('/api/v1/ai/available')).reading;
	} catch {
		return null;
	}
}
