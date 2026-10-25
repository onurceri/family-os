import type { ExternalHttp } from '@famos/sdk';
import type { OAuthClientsTable } from '../tables.ts';
import { hostOf, selfRegisteredUris } from './addresses.ts';
import { clientName, type OAuthBase } from './base.ts';
import {
	MAX_UNAPPROVED_METADATA,
	MAX_URI_LENGTH,
	METADATA_MAX_BYTES,
	METADATA_MAX_FRESH_MS,
	METADATA_MIN_FRESH_MS,
	METADATA_REMEMBERED,
	METADATA_TIMEOUT_MS,
} from './constants.ts';
import { OAuthError } from './errors.ts';
import type { OAuthDeps } from './types.ts';

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

/** Apps named by the address of their description, read from there and kept while fresh. */
export function createMetadataClients(deps: OAuthDeps, { t }: OAuthBase) {
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

	return { metadataClient };
}
