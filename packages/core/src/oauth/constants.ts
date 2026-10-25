import { DAY_MS, HOUR_MS } from '@famos/sdk';

export const OAUTH_SCOPES = ['familyos.read', 'familyos.suggest'] as const;
export const SETTINGS_KEY = 'mcp.oauth';
export const OAUTH_ACCESS_TOKEN_MS = HOUR_MS;
/** A grant ends after this long without being refreshed. */
export const OAUTH_GRANT_IDLE_DAYS = 90;
export const OAUTH_CODE_MS = 60 * 1000;
export const OAUTH_REQUEST_MS = 10 * 60 * 1000;
/** A refresh token presented again this soon after its use gets a new pair instead of ending the grant. */
export const OAUTH_REFRESH_GRACE_MS = 30 * 1000;
export const UNAPPROVED_MS = DAY_MS;
export const MAX_ACTIVE_TOKENS_PER_MEMBER = 20;
export const MAX_CLIENTS_PER_MEMBER = 10;
export const MAX_REDIRECT_URIS = 5;
export const MAX_URI_LENGTH = 2000;
export const MAX_STATE_LENGTH = 1024;
export const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** Apps that registered themselves (by request or by address) and no person has approved yet. */
export const MAX_UNAPPROVED_DYNAMIC = 50;
export const MAX_UNAPPROVED_METADATA = 200;
/** An app's description at its address: small, quick, and kept for a while the server allows. */
export const METADATA_MAX_BYTES = 5 * 1024;
export const METADATA_TIMEOUT_MS = 5000;
export const METADATA_MIN_FRESH_MS = 5 * 60 * 1000;
export const METADATA_MAX_FRESH_MS = DAY_MS;
export const METADATA_REMEMBERED = 500;
