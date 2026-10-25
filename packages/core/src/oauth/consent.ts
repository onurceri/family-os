import { type DbExecutor, FamosError } from '@famos/sdk';
import { randomSecret, sha256Hex } from '../secret-text.ts';
import type { OAuthClientsTable } from '../tables.ts';
import { hostOf, isLoopbackUri, redirectMatches } from './addresses.ts';
import { clientName, endGrants, type OAuthBase } from './base.ts';
import {
	MAX_ACTIVE_TOKENS_PER_MEMBER,
	MAX_STATE_LENGTH,
	MAX_URI_LENGTH,
	OAUTH_CODE_MS,
	OAUTH_REQUEST_MS,
	S256_CHALLENGE,
} from './constants.ts';
import { isOAuthError, OAuthError, type OAuthErrorCode } from './errors.ts';
import { type createMetadataClients, isMetadataClientId } from './metadata-clients.ts';
import { aiAppConnected } from './notification-kinds.ts';
import { ceilingOf, fromScopeText, SCOPE_OF } from './scopes.ts';
import type { OAuthSettingsPart } from './settings.ts';
import type { OAuthDeps, OAuthService } from './types.ts';

/** An app asks to sign in, and the person approves or denies it. */
export function createConsent(
	deps: OAuthDeps,
	{ t, atomic, connector, grantExpiry, checkResource }: OAuthBase,
	{ requireActive }: OAuthSettingsPart,
	{ metadataClient }: ReturnType<typeof createMetadataClients>,
): Pick<OAuthService, 'createRequest' | 'getRequest' | 'approve' | 'deny'> {
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

	return {
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

				// An earlier approval the app never came back for is superseded now. A sign-in the app
				// is using stays until this approval's code is exchanged: an approval abandoned
				// half way must not leave the person without the connection they had.
				const unused = await t(db)
					.selectFrom('core_api_tokens')
					.select('id')
					.where('member_id', '=', member.memberId)
					.where('oauth_client_id', '=', client.id)
					.where('revoked_at', 'is', null)
					.where('last_used_at', 'is', null)
					.execute();
				await endGrants(
					db,
					unused.map((r) => r.id),
					now,
				);
				// The sign-in this one replaces is not counted: one of the two goes at the exchange.
				const active = await t(db)
					.selectFrom('core_api_tokens')
					.select((eb) => eb.fn.countAll<number>().as('n'))
					.where('member_id', '=', member.memberId)
					.where('revoked_at', 'is', null)
					.where((eb) =>
						eb.or([eb('oauth_client_id', 'is', null), eb('oauth_client_id', '!=', client.id)]),
					)
					.executeTakeFirstOrThrow();
				if (Number(active.n) >= MAX_ACTIVE_TOKENS_PER_MEMBER)
					throw new FamosError('limit_reached', 'Too many keys; revoke one first');

				const grantId = deps.ids.next('api_token');
				await t(db)
					.insertInto('core_api_tokens')
					.values({
						id: grantId,
						member_id: member.memberId,
						name: clientName(client.name) || client.id,
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
	};
}
