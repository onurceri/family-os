import {
	type Actor,
	assertFullSignIn,
	type Clock,
	type DbExecutor,
	defineJob,
	defineNotificationKind,
	type ExtensionContext,
	type ExternalHttp,
	FamosError,
	hasBrand,
	type IdGenerator,
	type NotifyRequest,
	personPresent,
	systemActor,
} from '@famos/sdk';
import { z } from 'zod';
import type { Access } from './access.ts';
import {
	type ApiTokenScope,
	type AuthenticatedToken,
	OAUTH_ACCESS_PREFIX,
	OAUTH_CLIENT_SECRET_PREFIX,
	OAUTH_REFRESH_PREFIX,
} from './api-tokens.ts';
import type { AuditTrail } from './audit.ts';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { randomSecret, sameText, sha256Bytes, sha256Hex, toBase64Url } from './secret-text.ts';
import type { ApiTokenRow, CoreTables, OAuthClientsTable } from './tables.ts';

/**
 * Sign-in for AI apps: the part of an authorization server that knows the family's data. It
 * decides and stores; it has no HTTP, so the server turns its answers into responses. An access
 * token it issues resolves to the same caller a personal key does (`ApiTokenService.authenticate`),
 * so everything after the door is unchanged. Secrets are random, shown once and kept only as a
 * SHA-256.
 */

export const OAUTH_SCOPES = ['familyos.read', 'familyos.suggest'] as const;
const SETTINGS_KEY = 'mcp.oauth';
const DAY_MS = 24 * 60 * 60 * 1000;
export const OAUTH_ACCESS_TOKEN_MS = 60 * 60 * 1000;
/** A grant ends after this long without being refreshed. */
export const OAUTH_GRANT_IDLE_DAYS = 90;
export const OAUTH_CODE_MS = 60 * 1000;
export const OAUTH_REQUEST_MS = 10 * 60 * 1000;
/** A refresh token presented again this soon after its use gets a new pair instead of ending the grant. */
export const OAUTH_REFRESH_GRACE_MS = 30 * 1000;
const UNAPPROVED_MS = DAY_MS;
const MAX_ACTIVE_TOKENS_PER_MEMBER = 20;
const MAX_CLIENTS_PER_MEMBER = 10;
const MAX_REDIRECT_URIS = 5;
const MAX_URI_LENGTH = 2000;
const MAX_STATE_LENGTH = 1024;
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** Apps that registered themselves (by request or by address) and no person has approved yet. */
const MAX_UNAPPROVED_DYNAMIC = 50;
const MAX_UNAPPROVED_METADATA = 200;
/** An app's description at its address: small, quick, and kept for a while the server allows. */
const METADATA_MAX_BYTES = 5 * 1024;
const METADATA_TIMEOUT_MS = 5000;
const METADATA_MIN_FRESH_MS = 5 * 60 * 1000;
const METADATA_MAX_FRESH_MS = DAY_MS;
const METADATA_REMEMBERED = 500;

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

/** The member is told whenever an AI app is connected to their account. */
export const aiAppConnected = defineNotificationKind({
	id: 'core.aiAppConnected',
	label: 'app:notify_kind_ai_app_connected',
	audience: CORE_CAPABILITIES.mcpUse.id,
});
/** The member is told when an app's sign-in was cut off because it was used twice. */
export const aiAppDisconnected = defineNotificationKind({
	id: 'core.aiAppDisconnected',
	label: 'app:notify_kind_ai_app_disconnected',
	audience: CORE_CAPABILITIES.mcpUse.id,
});
export const oauthNotifications = [aiAppConnected, aiAppDisconnected];

export interface OAuthSettings {
	/** Let AI apps sign in with a FamilyOS account. */
	oauthEnabled: boolean;
	/** Let AI apps register themselves. */
	dcrEnabled: boolean;
	/** Allow this on a plain http address (a home network). */
	allowPlainHttp: boolean;
}

export type OAuthAddressProblem = 'no_address' | 'has_path' | 'plain_http';

export interface OAuthStatus extends OAuthSettings {
	/** Whether the endpoints answer: the MCP door is on, this is on, and the address is usable. */
	active: boolean;
	/** The family address OAuth uses as its issuer (an origin), or null when it cannot be used. */
	issuer: string | null;
	/** The address of the MCP door, which tokens are made for. */
	resource: string | null;
	/** Why the address cannot be used, if it cannot. */
	addressProblem: OAuthAddressProblem | null;
}

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

const isLoopbackHost = (host: string) =>
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

export interface OAuthClientView {
	id: string;
	/** What the app sends as `client_id`. */
	clientId: string;
	kind: OAuthClientsTable['kind'];
	name: string;
	redirectUris: string[];
	requirePkce: boolean;
	ownerMemberId: string | null;
	createdAt: number;
	lastConsentedAt: number | null;
}

/** What the consent page shows about a sign-in waiting for a decision. Never the state nor a code. */
export interface OAuthRequestView {
	id: string;
	client: {
		name: string;
		kind: OAuthClientsTable['kind'];
		createdAt: number;
		clientHost: string | null;
	};
	/** Where the person goes back to after deciding: the host is always shown. */
	redirectHost: string;
	/** The app runs on this device. */
	loopback: boolean;
	/** The most the person may give: what the app asked for. */
	scope: ApiTokenScope;
	expiresAt: number;
}

export interface AuthorizeInput {
	clientId: string;
	redirectUri: string;
	responseType?: string | undefined;
	state?: string | undefined;
	codeChallenge?: string | undefined;
	codeChallengeMethod?: string | undefined;
	scope?: string | undefined;
	resource?: string | undefined;
}

export interface TokenSet {
	accessToken: string;
	refreshToken: string;
	tokenType: 'Bearer';
	expiresIn: number;
	scope: string;
}

export interface ClientAuth {
	clientId: string;
	clientSecret?: string | undefined;
}

/** How long a description fetched from an app's address may be used, from its `Cache-Control`. */
export function metadataFreshMs(cacheControl: string | null | undefined): number {
	let seconds = 0;
	for (const part of (cacheControl ?? '').toLowerCase().split(',')) {
		const directive = part.trim();
		if (directive === 'no-store' || directive === 'no-cache') {
			seconds = 0;
			break;
		}
		const age = /^max-age=(\d{1,9})$/.exec(directive);
		if (age?.[1]) seconds = Number(age[1]);
	}
	return Math.min(METADATA_MAX_FRESH_MS, Math.max(METADATA_MIN_FRESH_MS, seconds * 1000));
}

/**
 * Whether a client id is an address of a description of the app (rather than an id we gave out):
 * https, a path, no login or fragment, and written the way a URL normalises, so there is one way
 * to spell it.
 */
export function isMetadataClientId(clientId: string): boolean {
	if (!clientId.startsWith('https://')) return false;
	let url: URL;
	try {
		url = new URL(clientId);
	} catch {
		return false;
	}
	return (
		url.href === clientId &&
		url.pathname !== '/' &&
		!url.hash &&
		!url.username &&
		!url.password &&
		!clientId.includes('#')
	);
}

export interface OAuthService {
	/** The same service on another executor: an action's unit of work, so it commits with it. */
	in(db: DbExecutor): OAuthService;

	settings(): Promise<OAuthSettings>;
	status(): Promise<OAuthStatus>;
	/** Changes the switches (admin); refuses what the address cannot carry. */
	setSettings(actor: Actor, patch: Partial<OAuthSettings>): Promise<OAuthSettings>;

	/** Checks an authorization request and keeps it for the person to decide on. */
	createRequest(input: AuthorizeInput): Promise<{ requestId: string }>;
	/** What the consent page shows; for the signed-in person who may decide it. */
	getRequest(actor: Actor, requestId: string): Promise<OAuthRequestView>;
	/** Gives the app a code, for the signed-in person. Replaces their earlier grant to this app. */
	approve(
		actor: Actor,
		requestId: string,
		choice?: { scope?: ApiTokenScope },
	): Promise<{ code: string; redirectUri: string; state: string | null; grantId: string }>;
	deny(actor: Actor, requestId: string): Promise<{ redirectUri: string; state: string | null }>;

	/** Codes for tokens. Throws `OAuthError`. */
	exchangeCode(input: {
		client: ClientAuth;
		code: string;
		redirectUri: string;
		codeVerifier?: string | undefined;
		resource?: string | undefined;
	}): Promise<TokenSet>;
	refresh(input: {
		client: ClientAuth;
		refreshToken: string;
		scope?: string | undefined;
		resource?: string | undefined;
	}): Promise<TokenSet>;
	/** RFC 7009: ends what the token stands for; never says whether it knew the token. */
	revokeToken(input: { client: ClientAuth; token: string }): Promise<void>;
	/** The caller an access token stands for, or null (the bearer lookup of `/mcp`). */
	authenticateAccess(secret: string): Promise<AuthenticatedToken | null>;

	/**
	 * An app registers itself (while the family allows it): a public client that no one has
	 * approved yet. Anyone on the network may call it, so it keeps no audit row and is limited.
	 * Throws `OAuthError`, or `limit_reached` when too many wait for approval.
	 */
	registerClient(input: {
		name?: string | undefined;
		redirectUris: unknown;
	}): Promise<OAuthClientView>;
	/** Sets up a client for the signed-in member; its secret is returned once. */
	createClient(
		actor: Actor,
		input: { name: string; redirectUris: readonly string[]; requirePkce?: boolean },
	): Promise<{ client: OAuthClientView; clientSecret: string }>;
	/** The member's own clients; with `all`, everyone's (needs `core.ai.manage`). */
	listClients(actor: Actor, options?: { all?: boolean }): Promise<OAuthClientView[]>;
	/** Removes a client and ends every grant it holds. */
	deleteClient(actor: Actor, id: string): Promise<OAuthClientView>;
	/** Removes what has expired. */
	cleanup(): Promise<void>;
}

export interface OAuthDeps {
	db: DbExecutor;
	clock: Clock;
	ids: IdGenerator;
	access: () => Access;
	audit: AuditTrail;
	/** The family's address (`FAMOS_BASE_URL`); issuer and resource come from it and nothing else. */
	publicUrl?: string | undefined;
	/** Guarded outbound HTTP, for reading an app's description at its address. */
	http?: ExternalHttp | undefined;
	/** Whether the MCP door itself is on. */
	mcpEnabled: () => Promise<boolean>;
	/** Queues a notification on `db` (the transaction of the change). */
	notify: (db: DbExecutor, request: NotifyRequest) => Promise<void>;
}

const SCOPE_OF: Record<ApiTokenScope, string> = {
	read: 'familyos.read',
	read_write: 'familyos.read familyos.suggest',
};

const clientView = (row: OAuthClientsTable): OAuthClientView => ({
	id: row.id,
	clientId: row.client_id,
	kind: row.kind,
	name: row.name,
	redirectUris: JSON.parse(row.redirect_uris) as string[],
	requirePkce: row.require_pkce === 1,
	ownerMemberId: row.owner_member_id,
	createdAt: row.created_at,
	lastConsentedAt: row.last_consented_at,
});

const hostOf = (uri: string): string => {
	try {
		return new URL(uri).host;
	} catch {
		return '';
	}
};

/** A name as shown: no control characters, at most 60 characters. */
const clientName = (name: string) =>
	[...name]
		.filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
		.join('')
		.trim()
		.slice(0, 60);

/**
 * The return addresses an app that named itself asks for: a few, each https or on this device
 * (the port of a device address is the app's to pick), with no login or fragment.
 */
function selfRegisteredUris(raw: unknown, code: OAuthErrorCode): string[] {
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

/** The most an app asked for. Words it does not know are ignored and never widen the grant. */
function ceilingOf(scope: string | undefined): ApiTokenScope {
	const words = new Set((scope ?? '').split(/\s+/).filter(Boolean));
	const known = OAUTH_SCOPES.filter((s) => words.has(s));
	if (known.length === 0) return 'read_write';
	return words.has('familyos.suggest') ? 'read_write' : 'read';
}

function fromScopeText(text: string): ApiTokenScope | null {
	const words = new Set(text.split(/\s+/).filter(Boolean));
	if (words.size === 0) return null;
	for (const w of words) if (!(OAUTH_SCOPES as readonly string[]).includes(w)) return null;
	return words.has('familyos.suggest') ? 'read_write' : 'read';
}

/**
 * Ends grants at once: they are revoked, the handles they were shown go, and the secrets an app
 * holds for them are deleted. Idempotent; takes the executor so it can run in a transaction.
 */
async function endGrants(db: DbExecutor, ids: readonly string[], now: number): Promise<void> {
	if (ids.length === 0) return;
	const t = db.withTables<CoreTables>();
	await t
		.updateTable('core_api_tokens')
		.set({ revoked_at: now })
		.where('id', 'in', ids)
		.where('revoked_at', 'is', null)
		.execute();
	await t.deleteFrom('core_api_token_handles').where('token_id', 'in', ids).execute();
	await t.deleteFrom('core_oauth_tokens').where('grant_id', 'in', ids).execute();
}

export function createOAuthService(deps: OAuthDeps): OAuthService {
	const t = (db: DbExecutor = deps.db) => db.withTables<CoreTables>();
	const atomic = <T>(fn: (db: DbExecutor) => Promise<T>): Promise<T> =>
		deps.db.isTransaction ? fn(deps.db) : deps.db.transaction().execute(fn);

	const readSettings = async (): Promise<OAuthSettings> => {
		const row = await t()
			.selectFrom('core_settings')
			.select('value')
			.where('key', '=', SETTINGS_KEY)
			.executeTakeFirst();
		const off = { oauthEnabled: false, dcrEnabled: false, allowPlainHttp: false };
		if (!row) return off;
		try {
			const v = JSON.parse(row.value) as Partial<Record<keyof OAuthSettings, unknown>>;
			return {
				oauthEnabled: v.oauthEnabled === true,
				dcrEnabled: v.dcrEnabled === true,
				allowPlainHttp: v.allowPlainHttp === true,
			};
		} catch {
			return off;
		}
	};

	const statusOf = async (): Promise<OAuthStatus> => {
		const settings = await readSettings();
		const address = inspectAddress(deps.publicUrl, settings.allowPlainHttp);
		const issuer = address.origin;
		return {
			...settings,
			active: settings.oauthEnabled && issuer !== null && (await deps.mcpEnabled()),
			issuer,
			resource: issuer ? `${issuer}/mcp` : null,
			addressProblem: address.problem,
		};
	};

	const requireActive = async (): Promise<OAuthStatus & { resource: string; issuer: string }> => {
		const status = await statusOf();
		if (!status.active || !status.resource || !status.issuer)
			throw new OAuthError('temporarily_unavailable', 'Signing in AI apps is not turned on');
		return { ...status, resource: status.resource, issuer: status.issuer };
	};

	/** The signed-in person who may connect an AI app: password sign-in, present, allowed. */
	const connector = (actor: Actor): Extract<Actor, { kind: 'member' }> => {
		if (!personPresent(actor)) throw new FamosError('unauthenticated', 'Sign in required');
		// An app's access outlasts this device: a PIN must never give it.
		assertFullSignIn(actor);
		if (!deps.access().can(actor, CORE_CAPABILITIES.mcpUse.id))
			throw new FamosError('forbidden', 'Not allowed to connect AI apps');
		return actor as Extract<Actor, { kind: 'member' }>;
	};

	const openRequest = async (db: DbExecutor, id: string, now: number) => {
		const row = await t(db)
			.selectFrom('core_oauth_requests')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row || row.decided_at !== null || row.expires_at <= now)
			throw new FamosError('gone', 'This sign-in request has ended. Start again in the app.');
		const client = await t(db)
			.selectFrom('core_oauth_clients')
			.selectAll()
			.where('id', '=', row.client_row_id)
			.where('revoked_at', 'is', null)
			.executeTakeFirst();
		if (!client) throw new FamosError('gone', 'This app is no longer known.');
		return { request: row, client };
	};

	const decideAllowed = (member: { memberId: string }, client: OAuthClientsTable): void => {
		if (client.kind === 'registered' && client.owner_member_id !== member.memberId)
			throw new FamosError('forbidden', 'This app was set up by someone else');
	};

	/** Checks the app's own credentials. A missing app and a wrong secret look the same. */
	const authenticateClient = async (db: DbExecutor, auth: ClientAuth) => {
		const row = await t(db)
			.selectFrom('core_oauth_clients')
			.selectAll()
			.where('client_id', '=', auth.clientId.slice(0, MAX_URI_LENGTH))
			.where('revoked_at', 'is', null)
			.executeTakeFirst();
		const given = auth.clientSecret ? await sha256Hex(auth.clientSecret.slice(0, 256)) : '';
		const wanted = row?.secret_hash ?? '';
		const secretOk = wanted === '' ? given === '' : sameText(given, wanted);
		if (!row || !secretOk)
			throw new OAuthError('invalid_client', 'The app could not be recognised');
		return row;
	};

	const issuePair = async (
		db: DbExecutor,
		grant: { id: string; expiresAt: number },
		resource: string,
		now: number,
	): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> => {
		const accessToken = `${OAUTH_ACCESS_PREFIX}${randomSecret()}`;
		const refreshToken = `${OAUTH_REFRESH_PREFIX}${randomSecret()}`;
		const accessId = deps.ids.next('oauth_token');
		const refreshId = deps.ids.next('oauth_token');
		const accessExpires = Math.min(now + OAUTH_ACCESS_TOKEN_MS, grant.expiresAt);
		await t(db)
			.insertInto('core_oauth_tokens')
			.values([
				{
					id: refreshId,
					grant_id: grant.id,
					kind: 'refresh',
					token_hash: await sha256Hex(refreshToken),
					resource,
					expires_at: grant.expiresAt,
					created_at: now,
					used_at: null,
					replaced_by: null,
					issued_with: accessId,
				},
				{
					id: accessId,
					grant_id: grant.id,
					kind: 'access',
					token_hash: await sha256Hex(accessToken),
					resource,
					expires_at: accessExpires,
					created_at: now,
					used_at: null,
					replaced_by: null,
					issued_with: refreshId,
				},
			])
			.execute();
		return { accessToken, refreshToken, expiresIn: Math.floor((accessExpires - now) / 1000) };
	};

	/** A grant that can still be used: not ended, not idle too long, its member still active. */
	const liveGrant = async (db: DbExecutor, grantId: string, clientRowId: string, now: number) => {
		const grant = await t(db)
			.selectFrom('core_api_tokens')
			.selectAll()
			.where('id', '=', grantId)
			.where('oauth_client_id', '=', clientRowId)
			.where('revoked_at', 'is', null)
			.executeTakeFirst();
		if (!grant || (grant.expires_at !== null && grant.expires_at <= now)) return null;
		const owner = await t(db)
			.selectFrom('core_members')
			.select('id')
			.where('id', '=', grant.member_id)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		return owner ? grant : null;
	};

	const grantExpiry = (now: number) => now + OAUTH_GRANT_IDLE_DAYS * DAY_MS;

	const checkResource = (given: string | undefined, resource: string) => {
		if (given !== undefined && given !== '' && given !== resource)
			throw new OAuthError('invalid_target', 'The token is not for this address');
	};

	const checkRedirectUris = (uris: readonly string[], allowPlainHttp: boolean): string[] => {
		if (uris.length === 0 || uris.length > MAX_REDIRECT_URIS)
			throw new FamosError(
				'bad_request',
				`An app needs 1 to ${MAX_REDIRECT_URIS} return addresses`,
			);
		const clean: string[] = [];
		for (const raw of uris) {
			if (raw.length > MAX_URI_LENGTH)
				throw new FamosError('bad_request', 'A return address is too long');
			let url: URL;
			try {
				url = new URL(raw);
			} catch {
				throw new FamosError('bad_request', 'A return address is not a web address');
			}
			const plainOk = url.protocol === 'http:' && (isLoopbackHost(url.hostname) || allowPlainHttp);
			if (url.protocol !== 'https:' && !plainOk)
				throw new FamosError('bad_request', 'A return address must use https');
			if (url.hash || url.username || url.password)
				throw new FamosError('bad_request', 'A return address cannot hold a fragment or a login');
			if (!clean.includes(raw)) clean.push(raw);
		}
		return clean;
	};

	/** When each fetched description may be used without asking its address again. */
	const metadataFreshUntil = new Map<string, number>();
	const rememberFresh = (clientId: string, until: number) => {
		metadataFreshUntil.delete(clientId);
		metadataFreshUntil.set(clientId, until);
		for (const key of metadataFreshUntil.keys()) {
			if (metadataFreshUntil.size <= METADATA_REMEMBERED) break;
			metadataFreshUntil.delete(key);
		}
	};

	/**
	 * The app named by an address: its description is read from there (a route may do this, as a
	 * bounded read that a person waits for; never inside a transaction), checked, and kept as a
	 * client row until it goes stale. Nothing in it is trusted beyond the return addresses: the
	 * name is shown with where the answer goes and who vouches for the app.
	 */
	const metadataClient = async (clientId: string): Promise<OAuthClientsTable> => {
		const unknown = () => new OAuthError('invalid_request', 'This app is not known to FamilyOS');
		const unreadable = () =>
			new OAuthError(
				'invalid_request',
				'FamilyOS could not read the app’s description at its address',
			);
		const wrong = (what: string) =>
			new OAuthError('invalid_request', `The app’s description at its address is wrong: ${what}`);
		if (!isMetadataClientId(clientId) || clientId.length > MAX_URI_LENGTH) throw unknown();
		const known = await t()
			.selectFrom('core_oauth_clients')
			.selectAll()
			.where('client_id', '=', clientId)
			.executeTakeFirst();
		if (known && (known.kind !== 'metadata' || known.revoked_at !== null)) throw unknown();
		const now = deps.clock.now();
		// After a restart nothing is remembered; the row's own time still covers the shortest stay.
		const freshUntil =
			metadataFreshUntil.get(clientId) ?? (known?.metadata_fetched_at ?? 0) + METADATA_MIN_FRESH_MS;
		if (known && freshUntil > now) return known;
		if (!deps.http) throw unreadable();

		let answer: Awaited<ReturnType<ExternalHttp['get']>>;
		try {
			answer = await deps.http.get({
				url: clientId,
				headers: { accept: 'application/json' },
				maxBytes: METADATA_MAX_BYTES,
				timeoutMs: METADATA_TIMEOUT_MS,
				redirects: 'none',
				...(known?.metadata_etag && { conditional: { etag: known.metadata_etag } }),
			});
		} catch {
			throw unreadable();
		}
		const keepUntil = now + metadataFreshMs(answer.cacheControl);
		if (answer.status === 304) {
			if (!known) throw unreadable();
			await t()
				.updateTable('core_oauth_clients')
				.set({ metadata_fetched_at: now })
				.where('id', '=', known.id)
				.execute();
			rememberFresh(clientId, keepUntil);
			return { ...known, metadata_fetched_at: now };
		}

		let document: unknown;
		try {
			document = JSON.parse(answer.text);
		} catch {
			throw wrong('it is not JSON');
		}
		if (typeof document !== 'object' || document === null || Array.isArray(document))
			throw wrong('it is not an object');
		const fields = document as Record<string, unknown>;
		// The address must name itself, exactly: a description cannot vouch for another address.
		if (fields.client_id !== clientId) throw wrong('it names another address');
		// A public client only: there is no secret to keep, so none is accepted.
		if (
			(fields.token_endpoint_auth_method !== undefined &&
				fields.token_endpoint_auth_method !== 'none') ||
			'client_secret' in fields
		)
			throw wrong('it asks for a secret');
		const redirectUris = selfRegisteredUris(fields.redirect_uris, 'invalid_request');
		const name =
			clientName(typeof fields.client_name === 'string' ? fields.client_name : '') ||
			hostOf(clientId);

		if (known) {
			await t()
				.updateTable('core_oauth_clients')
				.set({
					name,
					redirect_uris: JSON.stringify(redirectUris),
					metadata_fetched_at: now,
					metadata_etag: answer.etag,
				})
				.where('id', '=', known.id)
				.execute();
		} else {
			const waiting = await t()
				.selectFrom('core_oauth_clients')
				.select((eb) => eb.fn.countAll<number>().as('n'))
				.where('kind', '=', 'metadata')
				.where('last_consented_at', 'is', null)
				.where('revoked_at', 'is', null)
				.executeTakeFirstOrThrow();
			if (Number(waiting.n) >= MAX_UNAPPROVED_METADATA)
				throw new OAuthError(
					'temporarily_unavailable',
					'Too many apps are waiting for approval. Try again later.',
				);
			await t()
				.insertInto('core_oauth_clients')
				.values({
					id: deps.ids.next('oauth_client'),
					kind: 'metadata',
					client_id: clientId,
					name,
					redirect_uris: JSON.stringify(redirectUris),
					secret_hash: null,
					require_pkce: 1,
					owner_member_id: null,
					created_at: now,
					last_consented_at: null,
					metadata_fetched_at: now,
					metadata_etag: answer.etag,
					revoked_at: null,
				})
				// Two requests for a new app at once: the first one's row stands.
				.onConflict((oc) => oc.column('client_id').doNothing())
				.execute();
		}
		const stored = await t()
			.selectFrom('core_oauth_clients')
			.selectAll()
			.where('client_id', '=', clientId)
			.where('revoked_at', 'is', null)
			.executeTakeFirst();
		if (!stored) throw unknown();
		rememberFresh(clientId, keepUntil);
		return stored;
	};

	/** Ends one grant after its refresh token was used twice, and tells its member. */
	const cutOffForReplay = async (db: DbExecutor, grant: ApiTokenRow, now: number) => {
		await endGrants(db, [grant.id], now);
		await deps.audit.record(systemActor('oauth'), 'core.oauth.replay', grant.id, db);
		await deps.notify(db, {
			kind: aiAppDisconnected.id,
			to: { members: [grant.member_id] },
			title: { key: 'app:notify_ai_app_disconnected_title', params: { name: grant.name } },
			body: { key: 'app:notify_ai_app_disconnected_body', params: { name: grant.name } },
			url: '/settings/connected-apps',
			source: { kind: 'oauth', id: grant.id },
			dedupeKey: `replay:${grant.id}`,
		});
	};

	const service: OAuthService = {
		in: (db) => createOAuthService({ ...deps, db }),

		settings: readSettings,
		status: statusOf,

		async setSettings(actor, patch) {
			if (!personPresent(actor)) throw new FamosError('forbidden', 'Only members can do this');
			if (!deps.access().can(actor, CORE_CAPABILITIES.aiManage.id))
				throw new FamosError('forbidden', 'Not allowed to manage AI settings');
			const now = deps.clock.now();
			const current = await readSettings();
			const next: OAuthSettings = {
				oauthEnabled: patch.oauthEnabled ?? current.oauthEnabled,
				dcrEnabled: patch.dcrEnabled ?? current.dcrEnabled,
				allowPlainHttp: patch.allowPlainHttp ?? current.allowPlainHttp,
			};
			if (!next.oauthEnabled && patch.dcrEnabled === true)
				throw new FamosError('bad_request', 'Turn on signing in AI apps first');
			// Registration only means something while sign-in is on.
			if (!next.oauthEnabled) next.dcrEnabled = false;
			if (next.oauthEnabled) {
				const address = inspectAddress(deps.publicUrl, next.allowPlainHttp);
				if (address.problem === 'no_address')
					throw new FamosError('bad_request', 'Set the family address (FAMOS_BASE_URL) first');
				if (address.problem === 'has_path')
					throw new FamosError(
						'bad_request',
						'AI apps can sign in only when the family address has no path after the host',
					);
				if (address.problem === 'plain_http')
					throw new FamosError(
						'bad_request',
						'AI apps can sign in on an http address only when you allow it for the home network',
					);
			}
			const value = JSON.stringify(next);
			await t()
				.insertInto('core_settings')
				.values({ key: SETTINGS_KEY, value, updated_at: now })
				.onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
				.execute();
			return next;
		},

		async createRequest(input) {
			const status = await requireActive();
			if (!input.clientId || input.clientId.length > MAX_URI_LENGTH)
				throw new OAuthError('invalid_request', 'The app did not say who it is');
			const client = isMetadataClientId(input.clientId)
				? await metadataClient(input.clientId)
				: await t()
						.selectFrom('core_oauth_clients')
						.selectAll()
						.where('client_id', '=', input.clientId)
						.where('kind', '!=', 'metadata')
						.where('revoked_at', 'is', null)
						.executeTakeFirst();
			if (!client) throw new OAuthError('invalid_request', 'This app is not known to FamilyOS');
			if (
				!input.redirectUri ||
				input.redirectUri.length > MAX_URI_LENGTH ||
				!redirectMatches(JSON.parse(client.redirect_uris) as string[], input.redirectUri)
			)
				throw new OAuthError(
					'invalid_request',
					'The return address is not one this app registered',
				);
			// From here the app and its address are checked: later problems go back to the app.
			const fail = (code: OAuthErrorCode, message: string) => new OAuthError(code, message, true);
			if (input.state !== undefined && input.state.length > MAX_STATE_LENGTH)
				throw fail('invalid_request', 'The state is too long');
			if (input.responseType !== undefined && input.responseType !== 'code')
				throw fail('unsupported_response_type', 'Only the code flow is offered');
			const challenge = input.codeChallenge || undefined;
			if (challenge !== undefined) {
				// Only S256: a missing method is never taken to be `plain`.
				if (input.codeChallengeMethod !== 'S256' || !S256_CHALLENGE.test(challenge))
					throw fail('invalid_request', 'PKCE needs an S256 challenge');
			} else if (client.require_pkce === 1) {
				throw fail('invalid_request', 'This app must use PKCE');
			}
			try {
				checkResource(input.resource, status.resource);
			} catch (error) {
				if (isOAuthError(error)) throw fail(error.code, error.message);
				throw error;
			}
			if ((input.scope ?? '').length > 500) throw fail('invalid_scope', 'The scope is too long');
			const now = deps.clock.now();
			const id = randomSecret(16);
			await t()
				.insertInto('core_oauth_requests')
				.values({
					id,
					client_row_id: client.id,
					redirect_uri: input.redirectUri,
					state: input.state ?? null,
					code_challenge: challenge ?? null,
					scope_requested: SCOPE_OF[ceilingOf(input.scope)],
					resource: status.resource,
					created_at: now,
					expires_at: now + OAUTH_REQUEST_MS,
					decided_at: null,
					decision: null,
				})
				.execute();
			return { requestId: id };
		},

		async getRequest(actor, requestId) {
			const member = connector(actor);
			const { request, client } = await openRequest(deps.db, requestId, deps.clock.now());
			decideAllowed(member, client);
			let clientHost: string | null = null;
			if (client.kind === 'metadata') clientHost = hostOf(client.client_id);
			return {
				id: request.id,
				client: { name: client.name, kind: client.kind, createdAt: client.created_at, clientHost },
				redirectHost: hostOf(request.redirect_uri),
				loopback: isLoopbackUri(request.redirect_uri),
				scope: fromScopeText(request.scope_requested) ?? 'read',
				expiresAt: request.expires_at,
			};
		},

		async approve(actor, requestId, choice) {
			const member = connector(actor);
			const status = await requireActive().catch(() => {
				throw new FamosError('gone', 'Signing in AI apps is turned off');
			});
			return atomic(async (db) => {
				const now = deps.clock.now();
				const { request, client } = await openRequest(db, requestId, now);
				decideAllowed(member, client);
				const ceiling = fromScopeText(request.scope_requested) ?? 'read';
				const scope = choice?.scope ?? ceiling;
				// The person may narrow what the app asked for, never widen it.
				if (scope === 'read_write' && ceiling === 'read')
					throw new FamosError('bad_request', 'The app asked only to read');
				if (request.resource !== status.resource)
					throw new FamosError('gone', 'The family address changed. Start again in the app.');
				const claimed = await t(db)
					.updateTable('core_oauth_requests')
					.set({ decided_at: now, decision: 'approved' })
					.where('id', '=', requestId)
					.where('decided_at', 'is', null)
					.executeTakeFirst();
				if (Number(claimed.numUpdatedRows) === 0)
					throw new FamosError('gone', 'This sign-in request has ended. Start again in the app.');

				// Connecting again replaces the earlier grant: its secrets and handles go.
				const earlier = await t(db)
					.selectFrom('core_api_tokens')
					.select('id')
					.where('member_id', '=', member.memberId)
					.where('oauth_client_id', '=', client.id)
					.where('revoked_at', 'is', null)
					.execute();
				await endGrants(
					db,
					earlier.map((r) => r.id),
					now,
				);
				const active = await t(db)
					.selectFrom('core_api_tokens')
					.select((eb) => eb.fn.countAll<number>().as('n'))
					.where('member_id', '=', member.memberId)
					.where('revoked_at', 'is', null)
					.executeTakeFirstOrThrow();
				if (Number(active.n) >= MAX_ACTIVE_TOKENS_PER_MEMBER)
					throw new FamosError('limit_reached', 'Too many keys; revoke one first');

				const grantId = deps.ids.next('api_token');
				await t(db)
					.insertInto('core_api_tokens')
					.values({
						id: grantId,
						member_id: member.memberId,
						name: clientName(client.name) || 'AI app',
						// Never a hash a secret could have: a presented key can not match a grant.
						token_hash: `oauth:${grantId}`,
						scope,
						expires_at: grantExpiry(now),
						last_used_at: null,
						created_at: now,
						revoked_at: null,
						oauth_client_id: client.id,
					})
					.execute();
				await t(db)
					.updateTable('core_oauth_clients')
					.set({ last_consented_at: now })
					.where('id', '=', client.id)
					.execute();
				const code = randomSecret();
				await t(db)
					.insertInto('core_oauth_codes')
					.values({
						code_hash: await sha256Hex(code),
						request_id: requestId,
						grant_id: grantId,
						expires_at: now + OAUTH_CODE_MS,
						used_at: null,
						created_at: now,
					})
					.execute();
				await deps.audit.record(actor, 'core.oauth.grant', grantId, db);
				await deps.notify(db, {
					kind: aiAppConnected.id,
					to: { members: [member.memberId] },
					title: { key: 'app:notify_ai_app_connected_title', params: { name: client.name } },
					body: {
						key:
							scope === 'read'
								? 'app:notify_ai_app_connected_body_read'
								: 'app:notify_ai_app_connected_body_suggest',
						params: { name: client.name },
					},
					url: '/settings/connected-apps',
					source: { kind: 'oauth', id: grantId },
				});
				return { code, redirectUri: request.redirect_uri, state: request.state, grantId };
			});
		},

		async deny(actor, requestId) {
			const member = connector(actor);
			return atomic(async (db) => {
				const now = deps.clock.now();
				const { request, client } = await openRequest(db, requestId, now);
				decideAllowed(member, client);
				await t(db)
					.updateTable('core_oauth_requests')
					.set({ decided_at: now, decision: 'denied' })
					.where('id', '=', requestId)
					.where('decided_at', 'is', null)
					.execute();
				return { redirectUri: request.redirect_uri, state: request.state };
			});
		},

		async exchangeCode(input) {
			const status = await requireActive();
			const outcome = await atomic(async (db) => {
				const now = deps.clock.now();
				const client = await authenticateClient(db, input.client);
				const bad = () => new OAuthError('invalid_grant', 'The code is not valid');
				if (!input.code || input.code.length > 256) throw bad();
				const code = await t(db)
					.selectFrom('core_oauth_codes')
					.innerJoin('core_oauth_requests', 'core_oauth_requests.id', 'core_oauth_codes.request_id')
					.select([
						'core_oauth_codes.code_hash as code_hash',
						'core_oauth_codes.grant_id as grant_id',
						'core_oauth_codes.expires_at as code_expires_at',
						'core_oauth_codes.used_at as used_at',
						'core_oauth_requests.client_row_id as client_row_id',
						'core_oauth_requests.redirect_uri as redirect_uri',
						'core_oauth_requests.code_challenge as code_challenge',
						'core_oauth_requests.resource as resource',
					])
					.where('core_oauth_codes.code_hash', '=', await sha256Hex(input.code))
					.executeTakeFirst();
				if (!code || code.client_row_id !== client.id) throw bad();
				if (code.used_at !== null) {
					// A code is used once; seeing it again means someone else holds it too.
					await endGrants(db, [code.grant_id], now);
					return { replayed: true as const };
				}
				if (code.code_expires_at <= now) throw bad();
				if (input.redirectUri !== code.redirect_uri) throw bad();
				if (code.code_challenge !== null) {
					const verifier = input.codeVerifier ?? '';
					if (!PKCE_VERIFIER.test(verifier)) throw bad();
					const expected = toBase64Url(await sha256Bytes(verifier));
					if (!sameText(expected, code.code_challenge)) throw bad();
				}
				checkResource(input.resource, code.resource);
				if (code.resource !== status.resource) throw bad();
				const grant = await liveGrant(db, code.grant_id, client.id, now);
				if (!grant) throw bad();
				const used = await t(db)
					.updateTable('core_oauth_codes')
					.set({ used_at: now })
					.where('code_hash', '=', code.code_hash)
					.where('used_at', 'is', null)
					.executeTakeFirst();
				if (Number(used.numUpdatedRows) === 0) throw bad();
				const pair = await issuePair(
					db,
					{ id: grant.id, expiresAt: grantExpiry(now) },
					status.resource,
					now,
				);
				await t(db)
					.updateTable('core_api_tokens')
					// The first exchange is what makes it a sign-in: until then it is only an approval
					// whose code the app may never bring back.
					.set({ expires_at: grantExpiry(now), last_used_at: grant.last_used_at ?? now })
					.where('id', '=', grant.id)
					.execute();
				return {
					replayed: false as const,
					tokens: { ...pair, tokenType: 'Bearer' as const, scope: SCOPE_OF[grant.scope] },
				};
			});
			if (outcome.replayed) throw new OAuthError('invalid_grant', 'The code is not valid');
			return outcome.tokens;
		},

		async refresh(input) {
			const status = await requireActive();
			const outcome = await atomic(async (db) => {
				const now = deps.clock.now();
				const client = await authenticateClient(db, input.client);
				const bad = () => new OAuthError('invalid_grant', 'The refresh token is not valid');
				const given = input.refreshToken;
				if (!given.startsWith(OAUTH_REFRESH_PREFIX) || given.length > 128) throw bad();
				const token = await t(db)
					.selectFrom('core_oauth_tokens')
					.selectAll()
					.where('token_hash', '=', await sha256Hex(given))
					.where('kind', '=', 'refresh')
					.executeTakeFirst();
				if (!token) throw bad();
				const grant = await t(db)
					.selectFrom('core_api_tokens')
					.selectAll()
					.where('id', '=', token.grant_id)
					.executeTakeFirst();
				if (!grant || grant.oauth_client_id !== client.id) throw bad();
				if (!(await liveGrant(db, grant.id, client.id, now)) || token.expires_at <= now)
					throw bad();
				checkResource(input.resource, token.resource);
				if (token.resource !== status.resource) throw bad();
				if (input.scope) {
					const asked = fromScopeText(input.scope);
					if (asked === null || (asked === 'read_write' && grant.scope === 'read'))
						throw new OAuthError('invalid_scope', 'That is more than was granted');
				}
				const next = { id: grant.id, expiresAt: grantExpiry(now) };
				if (token.used_at === null) {
					const claimed = await t(db)
						.updateTable('core_oauth_tokens')
						.set({ used_at: now })
						.where('id', '=', token.id)
						.where('used_at', 'is', null)
						.executeTakeFirst();
					if (Number(claimed.numUpdatedRows) === 0) throw bad();
				} else {
					// Used already. Within the grace the answer was probably lost on the way: if
					// nobody has used the successor, it is replaced by a new pair (only hashes are
					// kept, so the first pair cannot be given again). Anything else is a second
					// holder of the secret.
					const successor = token.replaced_by
						? await t(db)
								.selectFrom('core_oauth_tokens')
								.selectAll()
								.where('id', '=', token.replaced_by)
								.executeTakeFirst()
						: undefined;
					if (
						now - token.used_at > OAUTH_REFRESH_GRACE_MS ||
						!successor ||
						successor.used_at !== null
					) {
						await cutOffForReplay(db, grant, now);
						return { replayed: true as const };
					}
					await t(db)
						.deleteFrom('core_oauth_tokens')
						.where('id', 'in', [
							successor.id,
							...(successor.issued_with ? [successor.issued_with] : []),
						])
						.execute();
				}
				const pair = await issuePair(db, next, status.resource, now);
				const created = await t(db)
					.selectFrom('core_oauth_tokens')
					.select('id')
					.where('token_hash', '=', await sha256Hex(pair.refreshToken))
					.executeTakeFirstOrThrow();
				await t(db)
					.updateTable('core_oauth_tokens')
					.set({ replaced_by: created.id })
					.where('id', '=', token.id)
					.execute();
				await t(db)
					.updateTable('core_api_tokens')
					.set({ expires_at: next.expiresAt })
					.where('id', '=', grant.id)
					.execute();
				return {
					replayed: false as const,
					tokens: { ...pair, tokenType: 'Bearer' as const, scope: SCOPE_OF[grant.scope] },
				};
			});
			if (outcome.replayed) throw new OAuthError('invalid_grant', 'The refresh token is not valid');
			return outcome.tokens;
		},

		async revokeToken({ client: auth, token }) {
			await atomic(async (db) => {
				const client = await authenticateClient(db, auth);
				if (!token || token.length > 128) return;
				const row = await t(db)
					.selectFrom('core_oauth_tokens')
					.innerJoin('core_api_tokens', 'core_api_tokens.id', 'core_oauth_tokens.grant_id')
					.select([
						'core_oauth_tokens.id as id',
						'core_oauth_tokens.kind as kind',
						'core_oauth_tokens.grant_id as grant_id',
						'core_api_tokens.oauth_client_id as client_row_id',
					])
					.where('core_oauth_tokens.token_hash', '=', await sha256Hex(token))
					.executeTakeFirst();
				// Another app's token is left alone and not mentioned.
				if (!row || row.client_row_id !== client.id) return;
				if (row.kind === 'refresh') await endGrants(db, [row.grant_id], deps.clock.now());
				else await t(db).deleteFrom('core_oauth_tokens').where('id', '=', row.id).execute();
			});
		},

		async authenticateAccess(secret) {
			if (!secret.startsWith(OAUTH_ACCESS_PREFIX) || secret.length > 128) return null;
			const status = await statusOf();
			if (!status.oauthEnabled || !status.resource) return null;
			const now = deps.clock.now();
			const token = await t()
				.selectFrom('core_oauth_tokens')
				.selectAll()
				.where('token_hash', '=', await sha256Hex(secret))
				.where('kind', '=', 'access')
				.executeTakeFirst();
			if (!token || token.expires_at <= now || token.resource !== status.resource) return null;
			const grant = await t()
				.selectFrom('core_api_tokens')
				.selectAll()
				.where('id', '=', token.grant_id)
				.where('revoked_at', 'is', null)
				.where('oauth_client_id', 'is not', null)
				.executeTakeFirst();
			if (!grant || (grant.expires_at !== null && grant.expires_at <= now)) return null;
			const owner = await t()
				.selectFrom('core_members')
				.select(['id', 'role_id'])
				.where('id', '=', grant.member_id)
				.where('archived_at', 'is', null)
				.executeTakeFirst();
			if (!owner) return null;
			return {
				token: {
					id: grant.id,
					memberId: grant.member_id,
					name: grant.name,
					scope: grant.scope,
					expiresAt: grant.expires_at,
					lastUsedAt: grant.last_used_at,
					createdAt: grant.created_at,
					revokedAt: grant.revoked_at,
					oauthClientId: grant.oauth_client_id,
				},
				member: { id: owner.id, roleId: owner.role_id },
			};
		},

		async registerClient(input) {
			const status = await statusOf();
			if (!status.active || !status.dcrEnabled)
				throw new OAuthError('temporarily_unavailable', 'Apps cannot register themselves here');
			const redirectUris = selfRegisteredUris(input.redirectUris, 'invalid_redirect_uri');
			const name = clientName(input.name ?? '') || hostOf(redirectUris[0] ?? '');
			return atomic(async (db) => {
				const waiting = await t(db)
					.selectFrom('core_oauth_clients')
					.select((eb) => eb.fn.countAll<number>().as('n'))
					.where('kind', '=', 'dynamic')
					.where('last_consented_at', 'is', null)
					.where('revoked_at', 'is', null)
					.executeTakeFirstOrThrow();
				if (Number(waiting.n) >= MAX_UNAPPROVED_DYNAMIC)
					throw new FamosError('limit_reached', 'Too many apps are waiting for approval');
				const id = deps.ids.next('oauth_client');
				const row: OAuthClientsTable = {
					id,
					kind: 'dynamic',
					client_id: id,
					name,
					redirect_uris: JSON.stringify(redirectUris),
					secret_hash: null,
					require_pkce: 1,
					owner_member_id: null,
					created_at: deps.clock.now(),
					last_consented_at: null,
					metadata_fetched_at: null,
					metadata_etag: null,
					revoked_at: null,
				};
				await t(db).insertInto('core_oauth_clients').values(row).execute();
				return clientView(row);
			});
		},

		async createClient(actor, input) {
			const member = connector(actor);
			const name = clientName(input.name);
			if (!name) throw new FamosError('bad_request', 'An app needs a name');
			const settings = await readSettings();
			const redirectUris = checkRedirectUris(input.redirectUris, settings.allowPlainHttp);
			return atomic(async (db) => {
				const owned = await t(db)
					.selectFrom('core_oauth_clients')
					.select((eb) => eb.fn.countAll<number>().as('n'))
					.where('owner_member_id', '=', member.memberId)
					.where('revoked_at', 'is', null)
					.executeTakeFirstOrThrow();
				if (Number(owned.n) >= MAX_CLIENTS_PER_MEMBER)
					throw new FamosError('limit_reached', 'Too many apps; remove one first');
				const secret = `${OAUTH_CLIENT_SECRET_PREFIX}${randomSecret()}`;
				const id = deps.ids.next('oauth_client');
				const row: OAuthClientsTable = {
					id,
					kind: 'registered',
					client_id: id,
					name,
					redirect_uris: JSON.stringify(redirectUris),
					secret_hash: await sha256Hex(secret),
					require_pkce: input.requirePkce === false ? 0 : 1,
					owner_member_id: member.memberId,
					created_at: deps.clock.now(),
					last_consented_at: null,
					metadata_fetched_at: null,
					metadata_etag: null,
					revoked_at: null,
				};
				await t(db).insertInto('core_oauth_clients').values(row).execute();
				await deps.audit.record(actor, 'core.oauth.registerClient', id, db);
				return { client: clientView(row), clientSecret: secret };
			});
		},

		async listClients(actor, options) {
			if (!personPresent(actor)) throw new FamosError('unauthenticated', 'Sign in required');
			if (options?.all && !deps.access().can(actor, CORE_CAPABILITIES.aiManage.id))
				throw new FamosError('forbidden', 'Not allowed to see everyone’s apps');
			let query = t()
				.selectFrom('core_oauth_clients')
				.selectAll()
				.where('revoked_at', 'is', null)
				.where('kind', '=', 'registered');
			if (!options?.all) query = query.where('owner_member_id', '=', actor.memberId);
			const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
			return rows.map(clientView);
		},

		async deleteClient(actor, id) {
			if (!personPresent(actor)) throw new FamosError('unauthenticated', 'Sign in required');
			const row = await t()
				.selectFrom('core_oauth_clients')
				.selectAll()
				.where('id', '=', id)
				.executeTakeFirst();
			// Someone else's app looks like a missing one, unless the caller manages AI.
			if (
				!row ||
				(row.owner_member_id !== actor.memberId &&
					!deps.access().can(actor, CORE_CAPABILITIES.aiManage.id))
			)
				throw new FamosError('not_found', 'App not found');
			if (row.revoked_at !== null) return clientView(row);
			const now = deps.clock.now();
			await t()
				.updateTable('core_oauth_clients')
				.set({ revoked_at: now, secret_hash: null })
				.where('id', '=', id)
				.execute();
			const grants = await t()
				.selectFrom('core_api_tokens')
				.select('id')
				.where('oauth_client_id', '=', id)
				.where('revoked_at', 'is', null)
				.execute();
			await endGrants(
				deps.db,
				grants.map((g) => g.id),
				now,
			);
			// Requests still waiting for this app can no longer be approved.
			await t().deleteFrom('core_oauth_requests').where('client_row_id', '=', id).execute();
			return clientView({ ...row, revoked_at: now });
		},

		async cleanup() {
			await cleanupExpired(deps.db, deps.clock.now());
		},
	};
	return service;
}

/**
 * Deletes expired requests, codes and tokens, the approvals whose code ran out without the app
 * ever exchanging it, and the apps that named themselves (by request or by address) and that
 * nobody approved in a day.
 */
export async function cleanupExpired(db: DbExecutor, now: number): Promise<void> {
	const tables = db.withTables<CoreTables>();
	// A grant is made when the person approves; one whose code ended unused was never a sign-in.
	// Its code is still here when it is deleted (same pass), so the order matters.
	const abandoned = await tables
		.selectFrom('core_api_tokens as g')
		.innerJoin('core_oauth_codes as c', 'c.grant_id', 'g.id')
		.select('g.id as id')
		.where('g.oauth_client_id', 'is not', null)
		.where('g.last_used_at', 'is', null)
		.where('c.used_at', 'is', null)
		.where('c.expires_at', '<=', now)
		.execute();
	if (abandoned.length > 0) {
		const ids = abandoned.map((g) => g.id);
		await tables.deleteFrom('core_oauth_codes').where('grant_id', 'in', ids).execute();
		await tables.deleteFrom('core_api_token_handles').where('token_id', 'in', ids).execute();
		await tables.deleteFrom('core_oauth_tokens').where('grant_id', 'in', ids).execute();
		await tables.deleteFrom('core_api_tokens').where('id', 'in', ids).execute();
	}
	await tables.deleteFrom('core_oauth_codes').where('expires_at', '<=', now).execute();
	await tables.deleteFrom('core_oauth_requests').where('expires_at', '<=', now).execute();
	await tables.deleteFrom('core_oauth_tokens').where('expires_at', '<=', now).execute();
	await tables
		.deleteFrom('core_oauth_clients')
		.where('kind', 'in', ['dynamic', 'metadata'])
		.where('last_consented_at', 'is', null)
		.where('created_at', '<=', now - UNAPPROVED_MS)
		.execute();
}

export const OAUTH_CLEANUP_JOB = 'core.oauthCleanup';

/** Runs once a day and keeps itself scheduled. */
export const oauthCleanup = defineJob({
	name: OAUTH_CLEANUP_JOB,
	payload: z.object({}),
	maxAttempts: 3,
	async handle(ctx) {
		const now = ctx.clock.now();
		await cleanupExpired(ctx.db, now);
		await scheduleOAuthCleanup(ctx, now + DAY_MS);
	},
});

/** One pending job per day, so restarts and the job's own rescheduling never pile up. */
export async function scheduleOAuthCleanup(
	ctx: Pick<ExtensionContext, 'enqueue'>,
	runAt: number,
): Promise<void> {
	await ctx.enqueue(
		OAUTH_CLEANUP_JOB,
		{},
		{ runAt, dedupeKey: `${OAUTH_CLEANUP_JOB}:${Math.floor(runAt / DAY_MS)}` },
	);
}
