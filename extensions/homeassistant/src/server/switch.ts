import {
	defineAction,
	defineJob,
	FamosError,
	isExternalHttpError,
	type JobContext,
} from '@famos/sdk';
import { z } from 'zod';
import {
	EntityIdSchema,
	ItemIdSchema,
	LabelSchema,
	OperationSchema,
	SwitchInputSchema,
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
import { tables } from './store.ts';
import { forgetValues } from './values.ts';

/**
 * Switching what the family allowed, through Home Assistant. The action only checks and enqueues
 * (a call to Home Assistant changes something outside, so it happens in a job, after the commit);
 * the job calls the one service the table names for the item's domain and the operation. The
 * address is built from the table, never from the input. Displays cannot run actions and the AI
 * may neither run nor suggest this one, so only a person who holds the capability switches.
 */

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
/** Taps on the same thing within this long are one switch. */
const DOUBLE_TAP_MS = 3_000;

const SwitchPayload = z.object({
	id: ItemIdSchema,
	operation: OperationSchema,
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
		const memberId = uow.actor.kind === 'member' ? uow.actor.memberId : null;
		const bucket = Math.floor(uow.clock.now() / DOUBLE_TAP_MS);
		await uow.enqueue(
			'homeassistant.switch',
			{
				id: row.id,
				operation: input.operation,
				memberId,
				label: row.label,
				entityId: row.entity_id,
			},
			{ dedupeKey: `homeassistant.switch:${row.id}:${input.operation}:${bucket}` },
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
	timeoutMs: 2 * TIMEOUT_MS,
	// One more try when Home Assistant did not answer; never more, a switch is wanted now.
	maxAttempts: 2,
	async handle(ctx, { id, operation, memberId, label, entityId }, run) {
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
		if (!row || !service || !connection || token === null) {
			ctx.logger.info({ status: 'not_sent' }, 'home assistant switch');
			return failed();
		}
		try {
			await ctx.http.post({
				url: `${connection.base_url}/api/services/${service.domain}/${service.service}`,
				json: { entity_id: row.entity_id },
				allowLocal: true,
				headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
				timeoutMs: TIMEOUT_MS,
				maxBytes: MAX_BYTES,
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
