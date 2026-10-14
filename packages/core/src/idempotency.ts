import {
	type DbExecutor,
	defineJob,
	ERROR_HTTP_STATUS,
	type ExtensionContext,
	FamosError,
	type FamosErrorCode,
	isFamosError,
} from '@famos/sdk';
import { z } from 'zod';
import type { CoreTables } from './tables.ts';

/** Request keys are kept this long: phones stay offline for days. */
export const IDEMPOTENCY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,100}$/;

/** Errors that are stored too, so a replay gives the same answer (a retry would fail the same way). */
const STORED_ERRORS: ReadonlySet<FamosErrorCode> = new Set([
	'bad_request',
	'forbidden',
	'not_found',
]);
export const isStoredError = (error: unknown): error is FamosError =>
	isFamosError(error) && STORED_ERRORS.has(error.code);

export interface IdempotencyRequest {
	key: string;
	memberId: string;
}

/** Thrown inside a transaction when the key turned out to be stored already; nothing was done. */
export class IdempotentReplay extends Error {
	readonly stored: StoredResult;
	constructor(stored: StoredResult) {
		super('idempotent replay');
		this.stored = stored;
	}
}

export type StoredResult =
	| { kind: 'result'; value: unknown }
	| { kind: 'error'; error: FamosError };

const table = (db: DbExecutor) => db.withTables<CoreTables>();

/** The stored answer for this member's key, if any. A key used for another action is refused. */
export async function findStored(
	db: DbExecutor,
	request: IdempotencyRequest,
	actionId: string,
): Promise<StoredResult | null> {
	const row = await table(db)
		.selectFrom('core_idempotency')
		.select(['action_id', 'status', 'response'])
		.where('member_id', '=', request.memberId)
		.where('key', '=', request.key)
		.executeTakeFirst();
	if (!row) return null;
	if (row.action_id !== actionId) {
		throw new FamosError(
			'idempotency_mismatch',
			'This Idempotency-Key was already used for a different action',
		);
	}
	const body: unknown = JSON.parse(row.response);
	if (row.status === 200) return { kind: 'result', value: body };
	const parsed = StoredErrorSchema.safeParse(body);
	const code = parsed.success ? parsed.data.code : 'bad_request';
	return {
		kind: 'error',
		error: new FamosError(
			code,
			parsed.success ? parsed.data.message : 'Request failed',
			parsed.success ? parsed.data.details : undefined,
		),
	};
}

const StoredErrorSchema = z.object({
	code: z.custom<FamosErrorCode>((v) => typeof v === 'string' && v in ERROR_HTTP_STATUS),
	message: z.string(),
	details: z.unknown().optional(),
});

/** Stores the answer; inside the action's transaction for a result. */
export async function storeResult(
	db: DbExecutor,
	request: IdempotencyRequest,
	actionId: string,
	now: number,
	result: unknown,
): Promise<void> {
	await insert(db, request, actionId, now, 200, result);
}

export async function storeError(
	db: DbExecutor,
	request: IdempotencyRequest,
	actionId: string,
	now: number,
	error: FamosError,
): Promise<void> {
	await insert(db, request, actionId, now, ERROR_HTTP_STATUS[error.code], {
		code: error.code,
		message: error.message,
		details: error.details,
	});
}

async function insert(
	db: DbExecutor,
	request: IdempotencyRequest,
	actionId: string,
	now: number,
	status: number,
	body: unknown,
) {
	await table(db)
		.insertInto('core_idempotency')
		.values({
			key: request.key,
			member_id: request.memberId,
			action_id: actionId,
			status,
			response: JSON.stringify(body),
			created_at: now,
		})
		.onConflict((oc) => oc.columns(['member_id', 'key']).doNothing())
		.execute();
}

export const PRUNE_JOB = 'core.pruneIdempotency';

/** Deletes keys older than a week once a day; keeps itself scheduled. */
export const pruneIdempotency = defineJob({
	name: PRUNE_JOB,
	payload: z.object({}),
	maxAttempts: 3,
	async handle(ctx) {
		const now = ctx.clock.now();
		await table(ctx.db)
			.deleteFrom('core_idempotency')
			.where('created_at', '<', now - IDEMPOTENCY_KEEP_MS)
			.execute();
		await schedulePrune(ctx, now + DAY_MS);
	},
});

/** One pending job per day, so restarts and the job's own rescheduling never pile up. */
export async function schedulePrune(
	ctx: Pick<ExtensionContext, 'enqueue'>,
	runAt: number,
): Promise<void> {
	await ctx.enqueue(
		PRUNE_JOB,
		{},
		{ runAt, dedupeKey: `${PRUNE_JOB}:${Math.floor(runAt / DAY_MS)}` },
	);
}
