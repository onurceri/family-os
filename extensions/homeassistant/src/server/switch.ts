import {
	defineAction,
	defineJob,
	FamosError,
	isExternalHttpError,
	type JobContext,
	selfOf,
} from '@famos/sdk';
import { z } from 'zod';
import {
	chosenOf,
	EntityIdSchema,
	ItemIdSchema,
	LabelSchema,
	needsAttributes,
	OperationSchema,
	SpeedLevelSchema,
	SwitchInputSchema,
	serviceBody,
	serviceDataRule,
	serviceFor,
} from '../contract/index.ts';
import {
	homeassistantControl,
	switchesChanged,
	switchFailed,
	valuesChanged,
} from './capabilities.ts';
import { load, recordTokenRefused } from './connection.ts';
import { recordSwitch } from './history.ts';
import { findItem, mayControl } from './items.ts';
import { CALL_MAX_BYTES, CALL_TIMEOUT_MS } from './limits.ts';
import { tables } from './store.ts';
import { forgetValues, request } from './values.ts';

/**
 * Switching what the family allowed, through Home Assistant. The action only checks and enqueues
 * (a call to Home Assistant changes something outside, so it happens in a job, after the commit);
 * the job calls the one service the table names for the item's domain and the operation. The
 * address is built from the table, never from the input, and the body holds the entity plus the
 * one field `SERVICE_DATA` allows for that operation, nothing else. Displays cannot run actions and the AI
 * may neither run nor suggest this one, so only a person who holds the capability switches.
 */

/** Taps on the same thing within this long are one switch. */
const DOUBLE_TAP_MS = 3_000;

const SwitchPayload = z.object({
	id: ItemIdSchema,
	operation: OperationSchema,
	/** What it sets: checked again against the contract's table before it is sent. */
	value: z.union([z.number(), z.string()]).optional(),
	level: SpeedLevelSchema.optional(),
	/** Who asked, to tell only them when it could not be done. */
	memberId: z.string().nullable(),
	/** The item's name when it was asked for; the item may be gone by the time the job runs. */
	label: LabelSchema.optional(),
	entityId: EntityIdSchema.optional(),
});

export const switchItem = defineAction({
	id: 'homeassistant.switch',
	title: 'Switch something through Home Assistant',
	input: SwitchInputSchema,
	output: z.object({ ok: z.literal(true) }),
	requires: homeassistantControl.id,
	approval: 'never',
	// Switching a light or a lock is a person's own act, never something suggested to them.
	refuseProposal: async () => 'Only a person can switch things in the home.',
	async run(uow, input) {
		const row = await findItem(uow, input.id);
		if (!mayControl(row))
			throw new FamosError('forbidden', 'This item may not be switched from FamilyOS');
		if (!serviceFor(row.entity_id, input.operation))
			throw new FamosError('bad_request', 'That cannot be done to this item');
		if (!serviceBody(row.entity_id, input.operation, input.value))
			throw new FamosError('bad_request', 'That value is not allowed for this item');
		// The level only words the history: it goes with a speed and with nothing else.
		if ((input.level === undefined) === (input.operation === 'set_percentage'))
			throw new FamosError('bad_request', 'A speed comes with its level, and nothing else does');
		const memberId = selfOf(uow.actor);
		const bucket = Math.floor(uow.clock.now() / DOUBLE_TAP_MS);
		await uow.enqueue(
			'homeassistant.switch',
			{
				id: row.id,
				operation: input.operation,
				value: input.value,
				level: input.level,
				memberId,
				label: row.label,
				entityId: row.entity_id,
			},
			{
				dedupeKey: `homeassistant.switch:${row.id}:${input.operation}:${input.value ?? ''}:${bucket}`,
			},
		);
		return { ok: true as const };
	},
});

const findRow = (ctx: JobContext, id: string) =>
	tables(ctx.db)
		.selectFrom('homeassistant_items')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirst();

export const switchJob = defineJob({
	name: 'homeassistant.switch',
	payload: SwitchPayload,
	timeoutMs: 2 * CALL_TIMEOUT_MS,
	// One more try when Home Assistant did not answer; never more, a switch is wanted now.
	maxAttempts: 2,
	async handle(ctx, { id, operation, value, level, memberId, label, entityId }, run) {
		const row = await findRow(ctx, id);
		const record = async (ok: boolean) => {
			const entity = row?.entity_id ?? entityId;
			const name = label ?? row?.label;
			if (!entity || !name) return;
			await recordSwitch(ctx, {
				id: run.id,
				itemId: id,
				entityId: entity,
				label: name,
				operation,
				level: level ?? null,
				chosen: chosenOf(operation, value),
				memberId,
				ok,
			});
			await ctx.events.emit(switchesChanged, {});
		};
		const failed = async () => {
			await record(false);
			if (memberId) await ctx.events.emitTo(memberId, switchFailed, { id });
		};
		// Removed, or no longer allowed, since it was asked for: nothing is sent.
		const service = row && mayControl(row) ? serviceFor(row.entity_id, operation) : null;
		const connection = await load(ctx.db);
		const token = connection ? ctx.secrets.open(connection.sealed_token) : null;
		// A rule that depends on the entity's own attributes (its limits or options) reads them now.
		const rule = row ? serviceDataRule(row.entity_id, operation) : null;
		let attributes: Record<string, unknown> | undefined;
		if (row && rule && needsAttributes(rule) && connection && token !== null) {
			try {
				const read = await ctx.http.get(
					request(
						connection.base_url,
						token,
						`/api/states/${row.entity_id}`,
						CALL_TIMEOUT_MS,
						CALL_MAX_BYTES,
					),
				);
				const parsed: unknown = read.status === 200 ? JSON.parse(read.text) : null;
				const found = (parsed as { attributes?: unknown } | null)?.attributes;
				attributes =
					typeof found === 'object' && found !== null && !Array.isArray(found)
						? (found as Record<string, unknown>)
						: {};
			} catch {
				attributes = {};
			}
		}
		const body = row ? serviceBody(row.entity_id, operation, value, attributes) : null;
		if (!row || !service || !body || !connection || token === null) {
			ctx.logger.info({ status: 'not_sent' }, 'home assistant switch');
			return failed();
		}
		try {
			await ctx.http.post({
				url: `${connection.base_url}/api/services/${service.domain}/${service.service}`,
				json: body,
				allowLocal: true,
				headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
				timeoutMs: CALL_TIMEOUT_MS,
				maxBytes: CALL_MAX_BYTES,
			});
		} catch (error) {
			const code = isExternalHttpError(error) ? error.code : 'failed';
			// Only the outcome: the address, the token and what was sent stay out of logs.
			ctx.logger.info({ status: code, attempt: run.attempt }, 'home assistant switch');
			if (code === 'http_401' || code === 'http_403') {
				await recordTokenRefused(ctx, connection.updated_at);
				return failed();
			}
			// No answer: the queue tries once more, then it is given up like any other failure.
			const transient = code === 'timeout' || code === 'unreachable' || /^http_5\d\d$/.test(code);
			if (transient && run.attempt < run.maxAttempts) throw error;
			return failed();
		}
		ctx.logger.info({ status: 'ok' }, 'home assistant switch');
		await record(true);
		forgetValues(ctx);
		await ctx.events.emit(valuesChanged, { id });
	},
});
