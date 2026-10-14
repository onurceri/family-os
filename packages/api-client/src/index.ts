import createClient, { type Client } from 'openapi-fetch';
import type { components, operations, paths } from './generated/schema.d.ts';

/**
 * Typed client for the FamilyOS API. The only way the web app and extensions (and future clients)
 * talk to the server. `paths` holds core's and the app's own routes, generated from
 * apps/server/openapi.json; each extension generates its own `paths` (its `./api` export) and
 * passes them as `Own`, so its client knows the host's routes and its own, nothing more.
 * Regenerate with `pnpm gen`.
 */
export type { components, operations, paths };
export type ApiClient<Own extends object = NoPaths> = Client<paths & Own>;
/** No routes beyond the host's: the web app's own client. */
export type NoPaths = Record<never, never>;

export interface ApiError {
	status: number;
	code: string;
	message: string;
	details?: unknown;
}

export function createApiClient<Own extends object = NoPaths>(
	options: { baseUrl?: string; fetch?: typeof fetch } = {},
): ApiClient<Own> {
	return createClient<paths & Own>({
		baseUrl: options.baseUrl ?? '',
		credentials: 'same-origin',
		// Looked up at each call, not once here: the web app wraps `fetch` after this module loads
		// (it counts reads in flight, apps/web/src/lib/net-activity.svelte.ts).
		fetch: options.fetch ?? ((input) => globalThis.fetch(input)),
	});
}

/** Unwraps an openapi-fetch result, throwing a normalized ApiError on failure. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
	if (result.error !== undefined || result.data === undefined) {
		const body = result.error as
			| { error?: { code?: string; message?: string; details?: unknown } }
			| undefined;
		throw {
			status: result.response.status,
			code: body?.error?.code ?? 'unknown',
			message: body?.error?.message ?? result.response.statusText,
			details: body?.error?.details,
		} satisfies ApiError;
	}
	return result.data;
}

export const isApiError = (value: unknown): value is ApiError =>
	typeof value === 'object' && value !== null && 'status' in value && 'code' in value;
