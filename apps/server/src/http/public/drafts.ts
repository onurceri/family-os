import { CORE_CAPABILITIES, type CoreTables, type DraftRow } from '@famos/core';
import {
	type Actor,
	type ApiContext,
	apiInstant,
	FamosError,
	memberBehind,
	principalOf,
} from '@famos/sdk';
import { z } from 'zod';
import {
	errorDocs,
	json,
	LIST_DRAFTS_SUMMARY,
	onBehalfHeader,
	type PublicParts,
	queryOf,
} from './shared.ts';
import {
	badFields,
	decodeCursor,
	encodeCursor,
	type Field,
	matchesTag,
	PAGE_DEFAULT,
	PAGE_MAX,
} from './wire.ts';

/** `GET /drafts/{draftId}` and `GET /drafts`: the suggestions an app made or may read. */
export function mountDrafts(parts: PublicParts) {
	const { api, kernel, contextOf, exposureOfAction } = parts;

	const DraftSchema = z
		.object({
			id: z.string(),
			status: z
				.enum(['waiting', 'applied', 'rejected', 'undone', 'expired', 'failed'])
				.describe(
					'`waiting` for a person to decide; `applied` it was approved and made; `rejected`; `undone` made and then taken back; `expired` its day passed undecided; `failed` approved but could not be made',
				),
			operation: z
				.string()
				.nullable()
				.describe('The `operationId` it was suggested through; null if that is no longer offered'),
			result: z
				.unknown()
				.optional()
				.describe(
					'With `applied`: what the operation would have answered, as in `result` of an applied change',
				),
			error: z.string().nullable().describe('With `failed`: why'),
			createdAt: z.string().describe('RFC 3339 with an offset'),
			decidedAt: z.string().nullable().describe('RFC 3339 with an offset'),
			timeZone: z.string(),
		})
		.meta({ id: 'Draft' });
	api.openAPIRegistry.registerPath({
		method: 'get',
		path: '/drafts/{draftId}',
		operationId: 'core.getDraft',
		summary:
			'How a suggestion this app (or the member it acts for) made ended, or that it still waits',
		tags: ['core'],
		security: [{ bearer: [] }],
		request: {
			params: z.object({ draftId: z.string() }),
			headers: z.object({ 'x-familyos-on-behalf-of': onBehalfHeader }),
		},
		responses: {
			200: { description: 'The draft', ...json(DraftSchema) },
			...errorDocs([401, 403, 404, 429]),
		},
	});
	api.get('/drafts/:draftId', async (c) => {
		const actor = c.get('actor');
		const row = await kernel.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.selectAll()
			.where('id', '=', c.req.param('draftId'))
			.executeTakeFirst();
		// Only who suggested it reads it, and anyone else is told it does not exist.
		const proposer = row ? principalOf(JSON.parse(row.proposed_by) as Actor) : null;
		if (!row || proposer !== principalOf(actor))
			throw new FamosError('not_found', 'No such suggestion');
		const ctx = await contextOf();
		const status = (
			{
				pending: 'waiting',
				approved: 'waiting',
				applied: 'applied',
				rejected: 'rejected',
				undone: 'undone',
				expired: 'expired',
				failed: 'failed',
			} as const
		)[row.status];
		const op = exposureOfAction.get(row.action_id);
		let result: unknown;
		if (row.status === 'applied' && row.result !== null && op?.exposure.output)
			result = op.exposure.output.project(JSON.parse(row.result), ctx);
		else if (row.status === 'applied' && row.result !== null && op) result = JSON.parse(row.result);
		return c.json(
			{
				id: row.id,
				status,
				operation: op?.exposure.name ?? null,
				...(result !== undefined && { result }),
				error: row.status === 'failed' ? row.error : null,
				createdAt: apiInstant(row.created_at, ctx.timeZone),
				decidedAt: row.decided_at === null ? null : apiInstant(row.decided_at, ctx.timeZone),
				timeZone: ctx.timeZone,
			},
			200,
		);
	});

	const DraftSummarySchema = z
		.object({
			id: z.string(),
			status: z
				.enum(['waiting', 'failed'])
				.describe(
					'`waiting` for a person to decide; `failed` approved but could not be made, and waiting to be tried again',
				),
			extension: z.string().describe('The extension the suggested change belongs to'),
			title: z
				.string()
				.describe('What it suggests, in the family language: the words of the suggestion'),
			subject: z.string().nullable().describe('What it is about, by name, when that is known'),
			proposedAt: z.string().describe('RFC 3339 with an offset'),
			proposedBy: z
				.string()
				.nullable()
				.describe(
					'Who suggested it: a person’s name, an app’s name, or `Leo via Home Assistant`; null when nobody is named',
				),
			canDecide: z
				.boolean()
				.describe('Always false here: only a person decides a suggestion, in FamilyOS itself'),
		})
		.meta({ id: 'DraftSummary' });
	const DraftSummaryPageSchema = z
		.object({
			items: z.array(DraftSummarySchema),
			next: z
				.string()
				.nullable()
				.describe('Pass it as `cursor` for the next page; null when this was the last'),
			timeZone: z.string().describe('The family time zone'),
		})
		.meta({ id: 'DraftSummaryPage' });
	api.openAPIRegistry.registerPath({
		method: 'get',
		path: '/drafts',
		operationId: 'core.listDrafts',
		summary: LIST_DRAFTS_SUMMARY,
		tags: ['core'],
		security: [{ bearer: [] }],
		request: {
			query: z.object({
				status: z
					.enum(['waiting'])
					.describe('Which suggestions; only `waiting` for now (those not yet decided)'),
				limit: z.coerce
					.number()
					.int()
					.min(1)
					.max(PAGE_MAX)
					.optional()
					.describe(`How many items at most; ${PAGE_DEFAULT} by default, ${PAGE_MAX} at most`),
				cursor: z.string().optional().describe('The `next` of the previous page'),
			}),
			headers: z.object({
				'if-none-match': z
					.string()
					.optional()
					.describe('The `ETag` of the last answer; an unchanged one is answered with 304'),
				'x-familyos-on-behalf-of': onBehalfHeader,
			}),
		},
		responses: {
			200: { description: 'The waiting suggestions', ...json(DraftSummaryPageSchema) },
			304: { description: 'Not modified since the `ETag` in `If-None-Match`' },
			...errorDocs([400, 401, 403, 429]),
		},
	});
	api.get('/drafts', async (c) => {
		const actor = c.get('actor');
		if (!kernel.access.can(actor, CORE_CAPABILITIES.draftsPropose.id))
			throw new FamosError('forbidden', 'This role may not read suggestions', {
				reason: 'capability',
				capability: CORE_CAPABILITIES.draftsPropose.id,
			});
		const { limit, cursor, ...rest } = queryOf(c);
		const fields: Field[] = [];
		if (rest.status !== 'waiting')
			fields.push({ path: 'status', message: 'Ask for the suggestions that are `waiting`' });
		let size = PAGE_DEFAULT;
		if (limit !== undefined) {
			const n = Number(limit);
			if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX)
				fields.push({ path: 'limit', message: `A whole number from 1 to ${PAGE_MAX}` });
			else size = n;
		}
		const offset = cursor ? decodeCursor(cursor) : 0;
		if (fields.length > 0) throw badFields(fields);

		const ctx = await contextOf();
		const rows = await kernel.runner.waitingFor(actor);
		// The ids and states are in the validator too: a suggestion that expires or fails is not
		// a write the log hears of.
		const window = JSON.stringify({
			p: c.req.path,
			q: Object.entries(rest).sort(),
			size,
			offset,
			tz: ctx.timeZone,
			lang: ctx.language,
			rows: rows.map((row) => `${row.id}:${row.status}`),
		});
		const tag = `"${await kernel.changes.collectionTag('core', actor, window)}"`;
		c.header('etag', tag);
		if (matchesTag(c.req.header('if-none-match'), tag)) return c.body(null, 304);

		const members = new Map((await kernel.ctx.family.members()).map((m) => [m.id, m.displayName]));
		const page = rows.slice(offset, offset + size);
		const items = await Promise.all(page.map((row) => summaryOf(row, ctx, members)));
		const next = offset + size < rows.length ? encodeCursor(offset + size) : null;
		return c.json({ items, next, timeZone: ctx.timeZone }, 200);
	});

	async function summaryOf(
		row: DraftRow,
		ctx: ApiContext,
		members: ReadonlyMap<string, string>,
	): Promise<z.infer<typeof DraftSummarySchema>> {
		const action = kernel.registry.actions.get(row.action_id);
		const by = JSON.parse(row.proposed_by) as Actor;
		const person = memberBehind(by);
		const name = person === null ? null : (members.get(person) ?? null);
		const through = await kernel.runner.appBehind(row);
		let proposedBy: string | null = name;
		if (through)
			proposedBy = name
				? ctx.translate('app:draft_via_app_member', { name, app: through.name })
				: through.name;
		return {
			id: row.id,
			status: row.status === 'failed' ? 'failed' : 'waiting',
			extension: row.action_id.split('.')[0] ?? row.action_id,
			title:
				row.summary ??
				(action?.draftTitle ? ctx.translate(action.draftTitle) : null) ??
				action?.title ??
				row.action_id,
			subject: await kernel.runner.subject(row),
			proposedAt: apiInstant(row.created_at, ctx.timeZone),
			proposedBy,
			canDecide: false,
		};
	}
}
