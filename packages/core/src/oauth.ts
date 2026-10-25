import { createOAuthBase } from './oauth/base.ts';
import { cleanupExpired } from './oauth/cleanup.ts';
import { createClients } from './oauth/clients.ts';
import { createConsent } from './oauth/consent.ts';
import { createMetadataClients } from './oauth/metadata-clients.ts';
import { createOAuthSettings } from './oauth/settings.ts';
import { createTokens } from './oauth/tokens.ts';
import type { OAuthDeps, OAuthService } from './oauth/types.ts';

/**
 * Sign-in for AI apps: the part of an authorization server that knows the family's data. It
 * decides and stores; it has no HTTP, so the server turns its answers into responses. An access
 * token it issues resolves to the same caller a personal key does (`ApiTokenService.authenticate`),
 * so everything after the door is unchanged. Secrets are random, shown once and kept only as a
 * SHA-256.
 */

export { inspectAddress, isLoopbackUri, redirectMatches } from './oauth/addresses.ts';
export {
	cleanupExpired,
	OAUTH_CLEANUP_JOB,
	oauthCleanup,
	scheduleOAuthCleanup,
} from './oauth/cleanup.ts';
export {
	OAUTH_ACCESS_TOKEN_MS,
	OAUTH_CODE_MS,
	OAUTH_GRANT_IDLE_DAYS,
	OAUTH_REFRESH_GRACE_MS,
	OAUTH_REQUEST_MS,
	OAUTH_SCOPES,
} from './oauth/constants.ts';
export { isOAuthError, OAuthError, type OAuthErrorCode } from './oauth/errors.ts';
export { isMetadataClientId, metadataFreshMs } from './oauth/metadata-clients.ts';
export {
	aiAppConnected,
	aiAppDisconnected,
	oauthNotifications,
} from './oauth/notification-kinds.ts';
export type {
	AuthorizeInput,
	ClientAuth,
	OAuthAddressProblem,
	OAuthClientView,
	OAuthDeps,
	OAuthRequestView,
	OAuthService,
	OAuthSettings,
	OAuthStatus,
	TokenSet,
} from './oauth/types.ts';

export function createOAuthService(deps: OAuthDeps): OAuthService {
	const base = createOAuthBase(deps);
	const settings = createOAuthSettings(deps, base);
	const metadata = createMetadataClients(deps, base);

	const service: OAuthService = {
		in: (db) => createOAuthService({ ...deps, db }),

		...settings.methods,
		...createConsent(deps, base, settings, metadata),
		...createTokens(deps, base, settings),
		...createClients(deps, base, settings),

		async cleanup() {
			await cleanupExpired(deps.db, deps.clock.now());
		},
	};
	return service;
}
