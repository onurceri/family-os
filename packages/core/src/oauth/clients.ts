import { FamosError, personPresent } from '@famos/sdk';
import { OAUTH_CLIENT_SECRET_PREFIX } from '../api-tokens.ts';
import { CORE_CAPABILITIES } from '../core-capabilities.ts';
import { randomSecret, sha256Hex } from '../secret-text.ts';
import type { OAuthClientsTable } from '../tables.ts';
import { hostOf, isLoopbackHost, selfRegisteredUris } from './addresses.ts';
import { clientName, endGrants, type OAuthBase } from './base.ts';
import {
	MAX_CLIENTS_PER_MEMBER,
	MAX_REDIRECT_URIS,
	MAX_UNAPPROVED_DYNAMIC,
	MAX_URI_LENGTH,
} from './constants.ts';
import { OAuthError } from './errors.ts';
import type { OAuthSettingsPart } from './settings.ts';
import type { OAuthClientView, OAuthDeps, OAuthService } from './types.ts';

export const clientView = (row: OAuthClientsTable): OAuthClientView => ({
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

/** Apps that register themselves, apps a member sets up, listing and removing them. */
export function createClients(
	deps: OAuthDeps,
	{ t, atomic, connector }: OAuthBase,
	{ readSettings, statusOf }: OAuthSettingsPart,
): Pick<OAuthService, 'registerClient' | 'createClient' | 'listClients' | 'deleteClient'> {
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

	return {
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
	};
}
