import { MAX_REDIRECT_URIS, MAX_URI_LENGTH } from './constants.ts';
import { OAuthError, type OAuthErrorCode } from './errors.ts';
import type { OAuthAddressProblem } from './types.ts';

/** The address of the family and what is wrong with it for OAuth, if anything. */
export function inspectAddress(
	publicUrl: string | undefined,
	allowPlainHttp: boolean,
): { origin: string; problem: null } | { origin: null; problem: OAuthAddressProblem } {
	if (!publicUrl) return { origin: null, problem: 'no_address' };
	let url: URL;
	try {
		url = new URL(publicUrl);
	} catch {
		return { origin: null, problem: 'no_address' };
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		return { origin: null, problem: 'no_address' };
	if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
		return { origin: null, problem: 'has_path' };
	if (url.protocol === 'http:' && !allowPlainHttp) return { origin: null, problem: 'plain_http' };
	return { origin: url.origin, problem: null };
}

export const isLoopbackHost = (host: string) =>
	host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/** `http://localhost`, `127.0.0.1` and `[::1]`: an app on the same device. */
export function isLoopbackUri(uri: string): boolean {
	try {
		const url = new URL(uri);
		return url.protocol === 'http:' && isLoopbackHost(url.hostname);
	} catch {
		return false;
	}
}

/**
 * Exact match of the whole address, except the port of a loopback address, which an app picks
 * when it starts.
 */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
	if (registered.includes(requested)) return true;
	if (!isLoopbackUri(requested)) return false;
	let want: URL;
	try {
		want = new URL(requested);
	} catch {
		return false;
	}
	return registered.some((uri) => {
		if (!isLoopbackUri(uri)) return false;
		const have = new URL(uri);
		return (
			have.hostname === want.hostname &&
			have.pathname === want.pathname &&
			have.search === want.search
		);
	});
}

export const hostOf = (uri: string): string => {
	try {
		return new URL(uri).host;
	} catch {
		return '';
	}
};

/**
 * The return addresses an app that named itself asks for: a few, each https or on this device
 * (the port of a device address is the app's to pick), with no login or fragment.
 */
export function selfRegisteredUris(raw: unknown, code: OAuthErrorCode): string[] {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REDIRECT_URIS)
		throw new OAuthError(code, `An app needs 1 to ${MAX_REDIRECT_URIS} return addresses`);
	const clean: string[] = [];
	for (const uri of raw) {
		if (typeof uri !== 'string' || uri.length > MAX_URI_LENGTH)
			throw new OAuthError(code, 'A return address is not usable');
		let url: URL;
		try {
			url = new URL(uri);
		} catch {
			throw new OAuthError(code, 'A return address is not a web address');
		}
		if (url.protocol !== 'https:' && !isLoopbackUri(uri))
			throw new OAuthError(code, 'A return address must use https');
		if (url.hash || url.username || url.password)
			throw new OAuthError(code, 'A return address cannot hold a fragment or a login');
		if (!clean.includes(uri)) clean.push(uri);
	}
	return clean;
}
