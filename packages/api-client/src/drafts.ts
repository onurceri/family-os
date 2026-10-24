import { type ApiClient, isApiError, type paths, unwrap } from './client.ts';

/** A draft as the API lists it (`GET /api/v1/core/drafts`). */
export type Draft =
	paths['/api/v1/core/drafts']['get']['responses'][200]['content']['application/json'][number];

/**
 * The calls every draft card makes, over any client built with `createApiClient` (core's draft
 * routes are in every client's `paths`). One place for Quick add, the assistant and any other
 * page that shows a suggestion.
 */
export function draftClient<Own extends object>(client: ApiClient<Own>) {
	// Every client knows the host's routes; `Own` only adds to them.
	const api = client as unknown as ApiClient;
	const post = async (draftId: string, verb: 'reject' | 'undo' | 'suggest-again' | 'replace') =>
		unwrap(
			await api.POST(`/api/v1/core/drafts/{draftId}/${verb}`, { params: { path: { draftId } } }),
		) as Draft;
	return {
		approve: async (draftId: string, input?: unknown): Promise<Draft> =>
			unwrap(
				await api.POST('/api/v1/core/drafts/{draftId}/approve', {
					params: { path: { draftId } },
					body: input === undefined ? {} : { input },
				}),
			),
		reject: (draftId: string) => post(draftId, 'reject'),
		undo: (draftId: string) => post(draftId, 'undo'),
		/** Sends a suggestion that was taken back again, as a new one waiting for approval. */
		suggestAgain: (draftId: string) => post(draftId, 'suggest-again'),
		/** Turns a suggestion into the change it offers instead (moving the event already there). */
		replace: (draftId: string) => post(draftId, 'replace'),
		/**
		 * Saves a person's change to a waiting suggestion on the server, so it survives a reload and
		 * is what anyone who approves it applies. Returns the saved input.
		 */
		edit: async (draftId: string, input: unknown): Promise<unknown> => {
			const result = unwrap(
				await api.POST('/api/v1/actions/core.editDraft', { body: { draftId, input } }),
			);
			// Saving needs no approval, so anything but "applied" means it was not saved.
			if (result.status !== 'applied') throw new Error('The change was not saved');
			return result.output.editedInput;
		},
		/** Whether an approval was refused because the suggestion was taken back meanwhile. */
		wasUndone: (error: unknown): boolean =>
			isApiError(error) && (error.details as { status?: unknown } | undefined)?.status === 'undone',
	};
}
