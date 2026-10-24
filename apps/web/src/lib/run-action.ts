import { isApiError, unwrap } from '@famos/api-client';
import { t, tDynamic } from './i18n.svelte.js';
import { refusalKey, refusalOfError } from './refusal.js';
import { toasts } from './toast.svelte.js';

/** What an openapi-fetch call answers with. */
export type Answer<T> = { data?: T; error?: unknown; response: Response };

export interface ActionFailure {
	/** `refused` for a 403, the API error's `code` otherwise, `unreachable` when no answer came. */
	reason: string;
	/** What was thrown: an `ApiError`, or the network's own error. */
	error: unknown;
	/** The words for the reader: a refusal's reason, `invalid` for a bad request, or the generic failure. */
	message: string;
}

export type ActionResult<T> = { ok: true; data: T } | ({ ok: false } & ActionFailure);

export interface RunActionOptions {
	/** Said as a notice when the change went through. */
	saved?: string;
	/** Words for a request the server found wrong (`bad_request`), instead of the generic failure. */
	invalid?: string;
	/** Tells the failure where the page wants it (an inline notice); without it the failure is a toast. */
	onError?: (failure: ActionFailure) => void;
	/** Reads the page's data again once the change went through. */
	reload?: () => unknown;
}

/**
 * Runs a change or read the page asked for and says how it went, so no page writes its own
 * try, unwrap, catch and notice. A refusal is explained in words by the shell already; here it
 * is also the failure's message, so an inline notice says the same. A page decides only what
 * to do with the answer.
 */
export async function runAction<T>(
	request: Promise<Answer<T>>,
	options: RunActionOptions = {},
): Promise<ActionResult<T>> {
	let data: T;
	try {
		data = unwrap(await request);
		if (options.saved) toasts.show(options.saved);
		await options.reload?.();
	} catch (error) {
		return fail(error, options);
	}
	return { ok: true, data };
}

function fail(error: unknown, options: RunActionOptions): ActionResult<never> {
	const refusal = refusalOfError(error);
	const failure: ActionFailure = refusal
		? { reason: 'refused', error, message: tDynamic(`app:${refusalKey(refusal.reason)}`) }
		: isApiError(error)
			? {
					reason: error.code,
					error,
					message:
						error.code === 'bad_request' && options.invalid ? options.invalid : t('error_generic'),
				}
			: { reason: 'unreachable', error, message: t('error_generic') };
	if (options.onError) options.onError(failure);
	else toasts.show(failure.message);
	return { ok: false, ...failure };
}
