import { AccessBook, type AccessSource } from './access-book.js';
import { api } from './api';

const fromServer: AccessSource = {
	async all() {
		const res = await api.GET('/api/v1/core/access');
		if (!res.data) throw new Error('access unavailable');
		return res.data.actions;
	},
	async check(actionId, input) {
		const res = await api.POST('/api/v1/actions/{actionId}/check', {
			params: { path: { actionId } },
			body: { input },
		});
		return res.data ?? null;
	},
};

const changes = $state({ n: 0 });

/** What the signed-in member may do, for the whole app; reactive. */
export const accessBook = new AccessBook(fromServer, {
	read: () => void changes.n,
	bump: () => changes.n++,
});
