import { isApiError } from '@famos/api-client';

/**
 * Whether a failed thread read means the thread no longer exists. Only the server's own
 * `not_found` answer does: a dropped request or a 5xx during a restart says nothing about the thread.
 */
export const threadIsGone = (error: unknown): boolean =>
	isApiError(error) && error.code === 'not_found';
