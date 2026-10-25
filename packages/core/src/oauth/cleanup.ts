import { DAY_MS, type DbExecutor, defineJob, type ExtensionContext } from '@famos/sdk';
import { z } from 'zod';
import type { CoreTables } from '../tables.ts';
import { UNAPPROVED_MS } from './constants.ts';

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
