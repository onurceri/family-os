import { type DbExecutor, systemActor } from '@famos/sdk';
import { OAUTH_ACCESS_PREFIX, OAUTH_REFRESH_PREFIX } from '../api-tokens.ts';
import { randomSecret, sameText, sha256Bytes, sha256Hex, toBase64Url } from '../secret-text.ts';
import type { ApiTokenRow } from '../tables.ts';
import { endGrants, type OAuthBase } from './base.ts';
import {
	MAX_URI_LENGTH,
	OAUTH_ACCESS_TOKEN_MS,
	OAUTH_REFRESH_GRACE_MS,
	PKCE_VERIFIER,
} from './constants.ts';
import { OAuthError } from './errors.ts';
import { aiAppDisconnected } from './notification-kinds.ts';
import { fromScopeText, SCOPE_OF } from './scopes.ts';
import type { OAuthSettingsPart } from './settings.ts';
import type { ClientAuth, OAuthDeps, OAuthService } from './types.ts';

/** Codes for tokens, refreshing and revoking them, and the caller an access token stands for. */
export function createTokens(
	deps: OAuthDeps,
	{ t, atomic, grantExpiry, checkResource }: OAuthBase,
	{ statusOf, requireActive }: OAuthSettingsPart,
): Pick<OAuthService, 'exchangeCode' | 'refresh' | 'revokeToken' | 'authenticateAccess'> {
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

	return {
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
				// Connecting again replaces the earlier sign-in once the new one works: its secrets
				// and handles go.
				const earlier = await t(db)
					.selectFrom('core_api_tokens')
					.select('id')
					.where('member_id', '=', grant.member_id)
					.where('oauth_client_id', '=', client.id)
					.where('revoked_at', 'is', null)
					.where('id', '!=', grant.id)
					.execute();
				await endGrants(
					db,
					earlier.map((r) => r.id),
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
	};
}
