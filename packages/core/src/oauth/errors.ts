import { hasBrand } from '@famos/sdk';

export type OAuthErrorCode =
	| 'invalid_request'
	| 'invalid_client'
	| 'invalid_grant'
	| 'invalid_scope'
	| 'invalid_target'
	| 'unsupported_response_type'
	| 'access_denied'
	| 'invalid_redirect_uri'
	| 'invalid_client_metadata'
	| 'temporarily_unavailable';

const OAUTH_ERROR = Symbol.for('famos.OAuthError');

/**
 * An answer in the words of RFC 6749 (`code`), for the server to send. `redirectable` is true
 * only after the client and the redirect address were checked, so the server may send the error
 * to the app; before that it shows it on its own page and redirects nowhere.
 */
export class OAuthError extends Error {
	readonly code: OAuthErrorCode;
	readonly redirectable: boolean;
	readonly [OAUTH_ERROR] = true;
	constructor(code: OAuthErrorCode, message: string, redirectable = false) {
		super(message);
		this.name = 'OAuthError';
		this.code = code;
		this.redirectable = redirectable;
	}
}
export const isOAuthError = (error: unknown): error is OAuthError => hasBrand(error, OAUTH_ERROR);
