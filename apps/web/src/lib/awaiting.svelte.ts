import type { AwaitedChange } from '@famos/ui/app';
import { api } from './api';
import { awaitedNew, changesById, waitingChanges } from './awaiting.js';
import { session } from './session.svelte.js';

/**
 * The changes that wait for approval and concern the signed-in member (their own, and those of
 * others they may decide), with the records they are about, so pages can mark them "Waiting for
 * approval" where the change was made and say what it will become, and lists can show a new entry
 * that waits. Read again after every change to a suggestion.
 */
class Awaiting {
	list = $state<readonly AwaitedChange[]>([]);
	changes = $derived(changesById(this.list));

	async refresh(): Promise<void> {
		const me = session.me?.id;
		// Only people who may propose read suggestions (approvers hold it as well).
		if (!me || !session.can('core.drafts.propose')) {
			this.list = [];
			return;
		}
		const read = async (status: 'pending' | 'failed') => {
			const res = await api.GET('/api/v1/core/drafts', {
				params: { query: { status, limit: 200 } },
			});
			return res.data ?? [];
		};
		try {
			// Newest first, so a thing with several waiting changes shows the latest.
			const drafts = (await Promise.all([read('pending'), read('failed')]))
				.flat()
				.toSorted((a, b) => b.createdAt - a.createdAt);
			this.list = waitingChanges(drafts, me);
		} catch {
			// Keep the marks known so far; the next change to a suggestion reads them again.
		}
	}

	has(id: string): boolean {
		return this.changes.has(id);
	}

	get(id: string): AwaitedChange | undefined {
		return this.changes.get(id);
	}

	added(actionIds: readonly string[], aboutId?: string): readonly AwaitedChange[] {
		return awaitedNew(this.list, actionIds, aboutId);
	}
}

export const awaiting = new Awaiting();
