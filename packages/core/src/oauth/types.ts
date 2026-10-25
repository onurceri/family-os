import type {
	Actor,
	Clock,
	DbExecutor,
	ExternalHttp,
	IdGenerator,
	NotifyRequest,
} from '@famos/sdk';
import type { Access } from '../access.ts';
import type { ApiTokenScope, AuthenticatedToken } from '../api-tokens.ts';
import type { AuditTrail } from '../audit.ts';
import type { OAuthClientsTable } from '../tables.ts';

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
	/** Gives the app a code, for the signed-in person. Their earlier sign-in to this app ends when the code is exchanged. */
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
