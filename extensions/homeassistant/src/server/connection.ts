import {
	defineAction,
	defineJob,
	defineRoute,
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
} from '../contract/index.ts';
import { connectionChanged, homeassistantManage } from './capabilities.ts';
import { isApiRoot, readConfig, statusOfError } from './check.ts';
import { CONNECTION_ID, type HomeAssistantTables, tables } from './store.ts';

/**
 * The connection to the family's Home Assistant. An admin enters the address and a long-lived
 * access token; the token is sealed and only the check job opens it. FamilyOS only ever reads from
 * Home Assistant (GET `/api/`, `/api/config`, later `/api/states/<entity>`): a token cannot be
 * limited there, so no request that changes anything is ever sent.
 */

type Row = HomeAssistantTables['homeassistant_connection'];

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
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

const load = (db: UnitOfWork['db']) =>
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

/** Asks Home Assistant who it is. Reads only; says nothing about the answer except what it means. */
export async function checkHomeAssistant(
	http: ExternalHttp,
	baseUrl: string,
	token: string,
): Promise<CheckResult> {
	const request = (path: string) => ({
		url: `${baseUrl}${path}`,
		allowLocal: true,
		headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
		timeoutMs: TIMEOUT_MS,
		maxBytes: MAX_BYTES,
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

export const connect = defineAction({
	id: 'homeassistant.connect',
	title: 'Connect to Home Assistant, or change the connection',
	input: ConnectInputSchema,
	output: ConnectionSchema,
	requires: homeassistantManage.id,
	approval: 'never',
	async run(uow, input) {
		const base = normalizeBaseUrl(input.url);
		if (!base) throw new FamosError('bad_request', 'The address is not an http or https address');
		const db = tables(uow.db);
		const current = await load(uow.db);
		// Strictly after the last change, so every change has a stamp of its own.
		const now = Math.max(uow.clock.now(), (current?.updated_at ?? 0) + 1);
		const fresh = {
			base_url: base.url,
			sealed_token: uow.secrets.seal(input.token),
			status: 'checking' as const,
			checked_at: null,
			ha_version: null,
			ha_name: null,
			updated_at: now,
		};
		if (current) {
			await db
				.updateTable('homeassistant_connection')
				.set(fresh)
				.where('id', '=', CONNECTION_ID)
				.execute();
		} else {
			await db
				.insertInto('homeassistant_connection')
				.values({ id: CONNECTION_ID, ...fresh, created_at: now })
				.execute();
		}
		await askForCheck(uow, now);
		uow.emit(connectionChanged, {});
		return toConnection(await load(uow.db));
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
