import {
	assertFullSignIn,
	defineAction,
	defineJob,
	defineRoute,
	type ExtensionContext,
	type ExternalHttp,
	FamosError,
	type UnitOfWork,
} from '@famos/sdk';
import { z } from 'zod';
import {
	ConnectInputSchema,
	type Connection,
	ConnectionSchema,
	type ConnectionStatus,
	normalizeBaseUrl,
	TestResultSchema,
} from '../contract/index.ts';
import { connectionChanged, homeassistantManage } from './capabilities.ts';
import { isApiRoot, readConfig, statusOfError } from './check.ts';
import { CALL_MAX_BYTES, CALL_TIMEOUT_MS, TEST_TIMEOUT_MS } from './limits.ts';
import { CONNECTION_ID, type HomeAssistantTables, tables } from './store.ts';

/**
 * The connection to the family's Home Assistant. An admin enters the address and a long-lived
 * access token; the token is sealed. FamilyOS reads with it (GET `/api/`, `/api/config`,
 * `/api/states`), and switches with it only what the family allowed, through the services of
 * `CONTROLS`: a token cannot be limited in Home Assistant, so FamilyOS sends nothing else.
 */

type Row = HomeAssistantTables['homeassistant_connection'];

/** Longer than the check job can run (two attempts of at most 40 s each). */
const STUCK_AFTER_MS = 2 * 60_000;

/** The connection as the API shows it. Never the token. */
export function toConnection(row: Row | undefined): Connection {
	const base = row && normalizeBaseUrl(row.base_url);
	if (!row || !base) return { connected: false };
	return {
		connected: true,
		address: { scheme: base.scheme, host: base.host, port: base.port, path: base.path },
		status: row.status,
		checkedAt: row.checked_at,
		version: row.ha_version,
		name: row.ha_name,
	};
}

export const load = (db: UnitOfWork['db']) =>
	tables(db).selectFrom('homeassistant_connection').selectAll().executeTakeFirst();

const CheckPayload = z.object({
	/** The `updated_at` of the connection this check is for. */
	stamp: z.number().int(),
});

/**
 * Asks for a check of the connection as it is now. The key holds the stamp, so a change made
 * while a check runs gets its own check, and the older one finds the stamp moved and stands down.
 */
function askForCheck(uow: UnitOfWork, stamp: number) {
	return uow.enqueue(
		'homeassistant.check',
		{ stamp },
		{ dedupeKey: `homeassistant.check:${stamp}` },
	);
}

export interface CheckResult {
	status: Exclude<ConnectionStatus, 'checking'>;
	version: string | null;
	name: string | null;
}

/**
 * Asks Home Assistant who it is. Reads only; says nothing about the answer except what it means.
 * Each read may take `CALL_TIMEOUT_MS`, or, with `deadlineMs`, both reads share that one deadline.
 */
export async function checkHomeAssistant(
	http: ExternalHttp,
	baseUrl: string,
	token: string,
	deadlineMs?: number,
): Promise<CheckResult> {
	const started = Date.now();
	const request = (path: string) => ({
		url: `${baseUrl}${path}`,
		allowLocal: true,
		headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
		timeoutMs:
			deadlineMs === undefined ? CALL_TIMEOUT_MS : Math.max(1, deadlineMs - (Date.now() - started)),
		maxBytes: CALL_MAX_BYTES,
	});
	try {
		const root = await http.get(request('/api/'));
		if (root.status !== 200 || !isApiRoot(root.text))
			return { status: 'not_home_assistant', version: null, name: null };
		const config = await http.get(request('/api/config'));
		const found = config.status === 200 ? readConfig(config.text) : null;
		if (!found) return { status: 'not_home_assistant', version: null, name: null };
		return { status: 'ok', ...found };
	} catch (error) {
		return { status: statusOfError(error), version: null, name: null };
	}
}

export const checkJob = defineJob({
	name: 'homeassistant.check',
	payload: CheckPayload,
	timeoutMs: 40_000,
	maxAttempts: 2,
	async handle(ctx, { stamp }) {
		const row = await load(ctx.db);
		// Changed or removed since this check was asked for: a newer check has been asked for, or none.
		if (!row || row.updated_at !== stamp) return;
		const token = ctx.secrets.open(row.sealed_token);
		const result: CheckResult =
			token === null
				? { status: 'failed', version: null, name: null }
				: await checkHomeAssistant(ctx.http, row.base_url, token);
		const done = await tables(ctx.db)
			.updateTable('homeassistant_connection')
			.set({
				status: result.status,
				checked_at: ctx.clock.now(),
				ha_version: result.version,
				ha_name: result.name,
			})
			// The answer belongs to the connection it was asked about.
			.where('id', '=', CONNECTION_ID)
			.where('updated_at', '=', stamp)
			.executeTakeFirst();
		// Only the status: the address, the token and what Home Assistant answered stay out of logs.
		ctx.logger.info({ status: result.status }, 'home assistant checked');
		if (Number(done.numUpdatedRows) > 0) await ctx.events.emit(connectionChanged, {});
	},
});

/**
 * Home Assistant refused the token while FamilyOS used it: the connection says so, as a check
 * would. Only when the connection is still the one the token came from (`stamp`).
 */
export async function recordTokenRefused(ctx: ExtensionContext, stamp: number): Promise<void> {
	const done = await tables(ctx.db)
		.updateTable('homeassistant_connection')
		.set({ status: 'token_refused', checked_at: ctx.clock.now() })
		.where('id', '=', CONNECTION_ID)
		.where('updated_at', '=', stamp)
		.executeTakeFirst();
	if (Number(done.numUpdatedRows) > 0) await ctx.events.emit(connectionChanged, {});
}

/**
 * Saves the address and the token. Setting a secret is a route, not an action: an action's input
 * is kept for drafts and its answer for replays, and the token must be in neither. It records
 * itself in the audit log (who, never the token) and needs a person at a password sign-in.
 */
export const saveConnection = defineRoute({
	method: 'put',
	path: '/connection',
	operationId: 'homeassistant.saveConnection',
	summary: 'Connect to Home Assistant, or change the connection',
	requires: homeassistantManage.id,
	body: ConnectInputSchema,
	response: ConnectionSchema,
	async handle(ctx, { body, actor }) {
		assertFullSignIn(actor);
		const base = normalizeBaseUrl(body.url);
		if (!base) throw new FamosError('bad_request', 'The address is not an http or https address');
		const db = tables(ctx.db);
		const current = await load(ctx.db);
		// Strictly after the last change, so every change has a stamp of its own.
		const now = Math.max(ctx.clock.now(), (current?.updated_at ?? 0) + 1);
		const fresh = {
			base_url: base.url,
			sealed_token: ctx.secrets.seal(body.token),
			status: 'checking' as const,
			checked_at: null,
			ha_version: null,
			ha_name: null,
			updated_at: now,
		};
		await db
			.insertInto('homeassistant_connection')
			.values({ id: CONNECTION_ID, ...fresh, created_at: now })
			.onConflict((conflict) => conflict.column('id').doUpdateSet(fresh))
			.execute();
		await ctx.audit.record(actor, 'homeassistant.saveConnection', CONNECTION_ID);
		await ctx.enqueue(
			'homeassistant.check',
			{ stamp: now },
			{ dedupeKey: `homeassistant.check:${now}` },
		);
		await ctx.events.emit(connectionChanged, {});
		return toConnection(await load(ctx.db));
	},
});

export const check = defineAction({
	id: 'homeassistant.check',
	title: 'Check the connection to Home Assistant again',
	input: z.object({}),
	output: ConnectionSchema,
	requires: homeassistantManage.id,
	approval: 'never',
	async run(uow) {
		const current = await load(uow.db);
		if (!current) throw new FamosError('not_found', 'Home Assistant is not connected');
		// Already being checked: asking again would only check twice. A check that never answered
		// (the server stopped while it ran) must not keep the button from working, though.
		if (current.status === 'checking' && uow.clock.now() - current.updated_at < STUCK_AFTER_MS)
			return toConnection(current);
		const now = Math.max(uow.clock.now(), current.updated_at + 1);
		await tables(uow.db)
			.updateTable('homeassistant_connection')
			.set({ status: 'checking', updated_at: now })
			.where('id', '=', CONNECTION_ID)
			.execute();
		await askForCheck(uow, now);
		uow.emit(connectionChanged, {});
		return toConnection(await load(uow.db));
	},
});

export const disconnect = defineAction({
	id: 'homeassistant.disconnect',
	title: 'Disconnect from Home Assistant and forget the token',
	input: z.object({}),
	output: z.object({ ok: z.literal(true) }),
	requires: homeassistantManage.id,
	approval: 'never',
	async run(uow) {
		await tables(uow.db).deleteFrom('homeassistant_connection').execute();
		uow.emit(connectionChanged, {});
		return { ok: true as const };
	},
});

export const getConnection = defineRoute({
	method: 'get',
	path: '/connection',
	operationId: 'homeassistant.getConnection',
	summary: 'The connection to Home Assistant (never the token)',
	requires: homeassistantManage.id,
	response: ConnectionSchema,
	async handle(ctx) {
		return toConnection(await load(ctx.db));
	},
});

/**
 * Tries an address and a token before they are saved, so the form can say what is wrong while the
 * person is still typing them. The same two reads as the check job, answered with the same
 * statuses; nothing is stored and the token is neither kept nor logged.
 */
export const testConnection = defineRoute({
	method: 'post',
	path: '/connection/test',
	operationId: 'homeassistant.testConnection',
	summary: 'Try an address and a token without saving them',
	requires: homeassistantManage.id,
	body: ConnectInputSchema,
	response: TestResultSchema,
	async handle(ctx, { body }) {
		const base = normalizeBaseUrl(body.url);
		if (!base) throw new FamosError('bad_request', 'The address is not an http or https address');
		const result = await checkHomeAssistant(ctx.http, base.url, body.token, TEST_TIMEOUT_MS);
		ctx.logger.info({ status: result.status }, 'home assistant tested');
		return result;
	},
});
