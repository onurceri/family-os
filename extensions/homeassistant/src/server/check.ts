import { isExternalHttpError } from '@famos/sdk';
import type { ConnectionStatus } from '../contract/index.ts';

/** Home Assistant's own words for itself are kept this short: they are shown, nothing more. */
const MAX_TEXT = 100;

/** What a failed request means for the family, as one of the connection's statuses. */
export function statusOfError(error: unknown): Exclude<ConnectionStatus, 'checking' | 'ok'> {
	if (!isExternalHttpError(error)) return 'failed';
	switch (error.code) {
		case 'http_401':
		case 'http_403':
			return 'token_refused';
		case 'http_404':
			return 'not_home_assistant';
		case 'blocked_address':
			return 'blocked_address';
		case 'timeout':
			return 'timeout';
		case 'unreachable':
		case 'bad_url':
			return 'unreachable';
		default:
			return 'failed';
	}
}

/** The answer of `GET /api/` is JSON with a text `message`; the words themselves do not matter. */
export function isApiRoot(text: string): boolean {
	try {
		const body: unknown = JSON.parse(text);
		return (
			typeof body === 'object' &&
			body !== null &&
			typeof (body as { message?: unknown }).message === 'string'
		);
	} catch {
		return false;
	}
}

const short = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT) : null;

/**
 * Picks the version and the name out of `GET /api/config`, and nothing else: the rest of it holds
 * where the home is (latitude, longitude, elevation) and how it is set up. Null when the answer
 * is not a JSON object.
 */
export function readConfig(text: string): { version: string | null; name: string | null } | null {
	try {
		const body: unknown = JSON.parse(text);
		if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
		const config = body as { version?: unknown; location_name?: unknown };
		return { version: short(config.version), name: short(config.location_name) };
	} catch {
		return null;
	}
}
