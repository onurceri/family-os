import {
	type Actor,
	assertFullSignIn,
	type Clock,
	type DbExecutor,
	FamosError,
	type IdGenerator,
	personPresent,
	type RoleId,
} from '@famos/sdk';
import { sql } from 'kysely';
import type { Access } from './access.ts';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { sha256Hex, toBase64Url } from './secret-text.ts';
import type { ApiTokenRow, CoreTables } from './tables.ts';

/** Every token starts with this, so a leaked one is recognisable (secret scanners, the owner). */
export const API_TOKEN_PREFIX = 'famos_';
/** An access token an AI app got by signing in; it is looked up apart from personal keys. */
export const OAUTH_ACCESS_PREFIX = 'famos_at_';
export const OAUTH_REFRESH_PREFIX = 'famos_rt_';
export const OAUTH_CLIENT_SECRET_PREFIX = 'famos_cs_';
const OAUTH_PREFIXES = [OAUTH_ACCESS_PREFIX, OAUTH_REFRESH_PREFIX, OAUTH_CLIENT_SECRET_PREFIX];
export const API_TOKEN_DEFAULT_DAYS = 90;
export const API_TOKEN_MAX_DAYS = 365;
/** Per member, so a script cannot fill the table. */
const MAX_TOKENS_PER_MEMBER = 20;
/** The handles remembered per token; the oldest go first. */
export const MAX_HANDLES_PER_TOKEN = 5000;
const SEEN_RESOLUTION_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SETTINGS_KEY = 'mcp';

export type ApiTokenScope = ApiTokenRow['scope'];

/** A token as the app shows it: never the secret, never its hash. */
export interface ApiTokenView {
	id: string;
	memberId: string;
	name: string;
	scope: ApiTokenScope;
	expiresAt: number | null;
	lastUsedAt: number | null;
	createdAt: number;
	revokedAt: number | null;
	/** The AI app that signed in, for a grant made by OAuth; null for a personal key. */
	oauthClientId: string | null;
}

export interface AuthenticatedToken {
	token: ApiTokenView;
	member: { id: string; roleId: RoleId };
}

/**
 * Personal API tokens: a member creates one in the app, sees it once, and gives it to
 * an AI app that speaks MCP. Only the SHA-256 is stored. Creating one returns its secret once, so
 * it stays outside actions (an action's answer is kept for replays); revoking a token and the
 * MCP switch run as core actions through `in(uow.db)`. Uses Web Crypto, so core stays
 * runtime-neutral.
 */
export interface ApiTokenService {
	/** The same service on another executor: an action's unit of work, so it commits with it. */
	in(db: DbExecutor): ApiTokenService;
	create(
		actor: Actor,
		input: { name: string; scope: ApiTokenScope; expiresInDays?: number },
	): Promise<{ secret: string; token: ApiTokenView }>;
	/** The caller's tokens; with `all`, everyone's (needs `core.ai.manage`). Newest first. */
	list(actor: Actor, options?: { all?: boolean }): Promise<ApiTokenView[]>;
	/** Revokes a token: the owner's, or any with `core.ai.manage`. */
	revoke(actor: Actor, tokenId: string): Promise<ApiTokenView>;
	/** Revokes every token of a member (archived). */
	revokeForMember(memberId: string): Promise<void>;
	/**
	 * The token behind a secret, or null when it is unknown, revoked, expired, or its member is
	 * archived. Changes nothing: a use that is then refused must not look like a use.
	 */
	authenticate(secret: string | null | undefined): Promise<AuthenticatedToken | null>;
	/** Records a permitted use (`lastUsedAt`), at most hourly. */
	touch(tokenId: string): Promise<void>;
	/** The ids a token was shown as these handles (handles it never saw are missing). */
	resolveHandles(tokenId: string, handles: readonly string[]): Promise<Map<string, string>>;
	/** Remembers handles shown to a token, so a later request can use them. */
	rememberHandles(
		tokenId: string,
		entries: readonly { handle: string; id: string }[],
	): Promise<void>;
	/** The feature switch for the MCP endpoint; off until an admin turns it on. */
	isEnabled(): Promise<boolean>;
	setEnabled(actor: Actor, enabled: boolean): Promise<void>;
}

const view = (row: ApiTokenRow): ApiTokenView => ({
	id: row.id,
	memberId: row.member_id,
	name: row.name,
	scope: row.scope,
	expiresAt: row.expires_at,
	lastUsedAt: row.last_used_at,
	createdAt: row.created_at,
	revokedAt: row.revoked_at,
	oauthClientId: row.oauth_client_id,
});

/**
 * Revokes every token of a member and forgets the handles they were shown. Idempotent, and takes
 * the executor so a sign-out, a new password or an archive can do it in their own transaction.
 */
export async function revokeTokensOf(db: DbExecutor, memberId: string, now: number): Promise<void> {
	const tokens = db.withTables<CoreTables>();
	const revoked = await tokens
		.updateTable('core_api_tokens')
		.set({ revoked_at: now })
		.where('member_id', '=', memberId)
		.where('revoked_at', 'is', null)
		.returning('id')
		.execute();
	if (revoked.length > 0)
		await tokens
			.deleteFrom('core_api_token_handles')
			.where(
				'token_id',
				'in',
				revoked.map((r) => r.id),
			)
			.execute();
}

export function createApiTokenService(deps: {
	db: DbExecutor;
	clock: Clock;
	ids: IdGenerator;
	access: () => Access;
	/** Resolves an OAuth access token (`famos_at_…`); personal keys never reach it. */
	authenticateOAuth?: (secret: string) => Promise<AuthenticatedToken | null>;
}): ApiTokenService {
	const tokens = () => deps.db.withTables<CoreTables>();
	const member = (actor: Actor): string => {
		if (!personPresent(actor)) throw new FamosError('unauthenticated', 'Sign in required');
		return actor.memberId;
	};

	return {
		in: (db) => createApiTokenService({ ...deps, db }),

		async create(actor, input) {
			// A token works away from this device for up to a year: a PIN must never mint one.
			assertFullSignIn(actor);
			const memberId = actor.memberId;
			if (!deps.access().can(actor, CORE_CAPABILITIES.mcpUse.id))
				throw new FamosError('forbidden', 'Not allowed to create API tokens');
			const name = input.name.trim().slice(0, 60);
			if (!name) throw new FamosError('bad_request', 'A token needs a name');
			const days = input.expiresInDays ?? API_TOKEN_DEFAULT_DAYS;
			if (!Number.isInteger(days) || days < 1 || days > API_TOKEN_MAX_DAYS)
				throw new FamosError(
					'bad_request',
					`A token lasts between 1 and ${API_TOKEN_MAX_DAYS} days`,
				);
			const active = await tokens()
				.selectFrom('core_api_tokens')
				.select((eb) => eb.fn.countAll<number>().as('n'))
				.where('member_id', '=', memberId)
				.where('revoked_at', 'is', null)
				.executeTakeFirstOrThrow();
			if (Number(active.n) >= MAX_TOKENS_PER_MEMBER)
				throw new FamosError('limit_reached', 'Too many tokens; revoke one first');

			// Never a secret that starts like an OAuth one: those are looked up elsewhere.
			let secret: string;
			do secret = `${API_TOKEN_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
			while (OAUTH_PREFIXES.some((prefix) => secret.startsWith(prefix)));
			const now = deps.clock.now();
			const row: ApiTokenRow = {
				id: deps.ids.next('api_token'),
				member_id: memberId,
				name,
				token_hash: await sha256Hex(secret),
				scope: input.scope,
				expires_at: now + days * DAY_MS,
				last_used_at: null,
				created_at: now,
				revoked_at: null,
				oauth_client_id: null,
			};
			await tokens().insertInto('core_api_tokens').values(row).execute();
			return { secret, token: view(row) };
		},

		async list(actor, options) {
			const memberId = member(actor);
			if (options?.all && !deps.access().can(actor, CORE_CAPABILITIES.aiManage.id))
				throw new FamosError('forbidden', 'Not allowed to see everyone’s tokens');
			// A sign-in is listed once the app has exchanged its code; an approval the app never
			// came back for is not a sign-in.
			let query = tokens()
				.selectFrom('core_api_tokens')
				.selectAll()
				.where((eb) =>
					eb.or([eb('oauth_client_id', 'is', null), eb('last_used_at', 'is not', null)]),
				);
			if (!options?.all) query = query.where('member_id', '=', memberId);
			const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
			return rows.map(view);
		},

		async revoke(actor, tokenId) {
			const memberId = member(actor);
			const row = await tokens()
				.selectFrom('core_api_tokens')
				.selectAll()
				.where('id', '=', tokenId)
				.executeTakeFirst();
			// Someone else's token looks like a missing one, unless the caller manages AI.
			if (
				!row ||
				(row.member_id !== memberId && !deps.access().can(actor, CORE_CAPABILITIES.aiManage.id))
			)
				throw new FamosError('not_found', 'Token not found');
			if (row.revoked_at !== null) return view(row);
			const now = deps.clock.now();
			await tokens()
				.updateTable('core_api_tokens')
				.set({ revoked_at: now })
				.where('id', '=', tokenId)
				.execute();
			await tokens().deleteFrom('core_api_token_handles').where('token_id', '=', tokenId).execute();
			return view({ ...row, revoked_at: now });
		},

		async revokeForMember(memberId) {
			await revokeTokensOf(deps.db, memberId, deps.clock.now());
		},

		async authenticate(secret) {
			if (!secret?.startsWith(API_TOKEN_PREFIX)) return null;
			if (secret.length > 128) return null;
			if (secret.startsWith(OAUTH_ACCESS_PREFIX))
				return (await deps.authenticateOAuth?.(secret)) ?? null;
			const row = await tokens()
				.selectFrom('core_api_tokens')
				.selectAll()
				.where('token_hash', '=', await sha256Hex(secret))
				.where('revoked_at', 'is', null)
				.executeTakeFirst();
			if (!row) return null;
			const now = deps.clock.now();
			if (row.expires_at !== null && row.expires_at <= now) return null;
			const owner = await tokens()
				.selectFrom('core_members')
				.select(['id', 'role_id'])
				.where('id', '=', row.member_id)
				.where('archived_at', 'is', null)
				.executeTakeFirst();
			if (!owner) return null;
			return { token: view(row), member: { id: owner.id, roleId: owner.role_id } };
		},

		async touch(tokenId) {
			const now = deps.clock.now();
			await tokens()
				.updateTable('core_api_tokens')
				.set({ last_used_at: now })
				.where('id', '=', tokenId)
				.where((eb) =>
					eb.or([
						eb('last_used_at', 'is', null),
						eb('last_used_at', '<=', now - SEEN_RESOLUTION_MS),
					]),
				)
				.execute();
		},

		async resolveHandles(tokenId, handles) {
			const found = new Map<string, string>();
			if (handles.length === 0) return found;
			const rows = await tokens()
				.selectFrom('core_api_token_handles')
				.select(['handle', 'ref_id'])
				.where('token_id', '=', tokenId)
				.where('handle', 'in', [...new Set(handles)].slice(0, 200))
				.execute();
			for (const r of rows) found.set(r.handle, r.ref_id);
			return found;
		},

		async rememberHandles(tokenId, entries) {
			if (entries.length === 0) return;
			const now = deps.clock.now();
			await tokens()
				.insertInto('core_api_token_handles')
				.values(
					entries.map((e) => ({
						token_id: tokenId,
						handle: e.handle,
						ref_id: e.id,
						created_at: now,
					})),
				)
				.onConflict((oc) => oc.columns(['token_id', 'handle']).doNothing())
				.execute();
			// Keep the newest ones; a client that lists a lot only loses handles it saw long ago.
			await sql`delete from core_api_token_handles where token_id = ${tokenId} and rowid in (
				select rowid from core_api_token_handles where token_id = ${tokenId}
				order by created_at desc, rowid desc limit -1 offset ${MAX_HANDLES_PER_TOKEN})`.execute(
				deps.db,
			);
		},

		async isEnabled() {
			const row = await tokens()
				.selectFrom('core_settings')
				.select('value')
				.where('key', '=', SETTINGS_KEY)
				.executeTakeFirst();
			if (!row) return false;
			try {
				return (JSON.parse(row.value) as { enabled?: unknown }).enabled === true;
			} catch {
				return false;
			}
		},

		async setEnabled(actor, enabled) {
			member(actor);
			if (!deps.access().can(actor, CORE_CAPABILITIES.aiManage.id))
				throw new FamosError('forbidden', 'Not allowed to manage AI settings');
			const now = deps.clock.now();
			const value = JSON.stringify({ enabled });
			await tokens()
				.insertInto('core_settings')
				.values({ key: SETTINGS_KEY, value, updated_at: now })
				.onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
				.execute();
		},
	};
}
