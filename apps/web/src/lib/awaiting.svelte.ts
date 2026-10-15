import { api } from './api';
import { awaitedIds } from './awaiting.js';
import { session } from './session.svelte.js';

/**
 * The records the signed-in member's own changes wait on someone else to approve, so pages can
 * mark them "Waiting for approval" where the change was made. Read again after every change to a
 * suggestion.
 */
class Awaiting {
	ids = $state(new Set<string>());

	async refresh(): Promise<void> {
		const me = session.me?.id;
		// Only people who may propose have changes that wait.
		if (!me || !session.can('core.drafts.propose')) {
			this.ids = new Set();
			return;
		}
		const read = async (status: 'pending' | 'failed') => {
			const res = await api.GET('/api/v1/core/drafts', {
				params: { query: { status, limit: 200 } },
			});
			return res.data ?? [];
		};
		try {
			const drafts = (await Promise.all([read('pending'), read('failed')])).flat();
			this.ids = awaitedIds(drafts, me);
		} catch {
			// Keep the marks known so far; the next change to a suggestion reads them again.
		}
	}

	has(id: string): boolean {
		return this.ids.has(id);
	}
}

export const awaiting = new Awaiting();
