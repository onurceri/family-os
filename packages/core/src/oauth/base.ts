import {
	type Actor,
	assertFullSignIn,
	DAY_MS,
	type DbExecutor,
	FamosError,
	personPresent,
} from '@famos/sdk';
import { CORE_CAPABILITIES } from '../core-capabilities.ts';
import { shownName } from '../shown-name.ts';
import type { CoreTables } from '../tables.ts';
import { OAUTH_GRANT_IDLE_DAYS } from './constants.ts';
import { OAuthError } from './errors.ts';
import type { OAuthDeps } from './types.ts';

/** A name as shown: printable text only, at most 60 characters. */
export const clientName = (name: string) => shownName(name);

/**
 * Ends grants at once: they are revoked, the handles they were shown go, and the secrets an app
 * holds for them are deleted. Idempotent; takes the executor so it can run in a transaction.
 */
export async function endGrants(
	db: DbExecutor,
	ids: readonly string[],
	now: number,
): Promise<void> {
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

/** What every part of the service shares: its tables, transactions and the checks they all make. */
export function createOAuthBase(deps: OAuthDeps) {
	const t = (db: DbExecutor = deps.db) => db.withTables<CoreTables>();
	const atomic = <T>(fn: (db: DbExecutor) => Promise<T>): Promise<T> =>
		deps.db.isTransaction ? fn(deps.db) : deps.db.transaction().execute(fn);

	/** The signed-in person who may connect an AI app: password sign-in, present, allowed. */
	const connector = (actor: Actor): Extract<Actor, { kind: 'member' }> => {
		if (!personPresent(actor)) throw new FamosError('unauthenticated', 'Sign in required');
		// An app's access outlasts this device: a PIN must never give it.
		assertFullSignIn(actor);
		if (!deps.access().can(actor, CORE_CAPABILITIES.mcpUse.id))
			throw new FamosError('forbidden', 'Not allowed to connect AI apps');
		return actor as Extract<Actor, { kind: 'member' }>;
	};

	const grantExpiry = (now: number) => now + OAUTH_GRANT_IDLE_DAYS * DAY_MS;

	const checkResource = (given: string | undefined, resource: string) => {
		if (given !== undefined && given !== '' && given !== resource)
			throw new OAuthError('invalid_target', 'The token is not for this address');
	};

	return { t, atomic, connector, grantExpiry, checkResource };
}

export type OAuthBase = ReturnType<typeof createOAuthBase>;
