import { apiInstant } from '@famos/sdk';
import { z } from 'zod';
import { errorDocs, json, onBehalfHeader, type PublicParts } from './shared.ts';
import { badFields } from './wire.ts';

/** `GET /changes`: what changed since a cursor, for the things the caller may see. */
export function mountChangeFeed(parts: PublicParts) {
	const { api, kernel, contextOf, operations } = parts;

	const ChangesSchema = z
		.object({
			changes: z.array(
				z.object({
					seq: z.number().int(),
					at: z.string().describe('RFC 3339 with an offset'),
					extension: z.string(),
					entity: z
						.string()
						.describe(
							'What kind of thing: `event`, `task`, `shopping_item`, `shopping_list`, `chore`, `note` and others; ignore a kind you do not know',
						),
					id: z.string().describe('Its id'),
					op: z
						.enum(['upsert', 'delete'])
						.describe('`upsert`: read it again; `delete`: it is gone for you'),
				}),
			),
			cursor: z.number().int().describe('Pass it as `since` next time'),
			more: z.boolean().describe('True when there is more after `cursor`: ask again at once'),
			timeZone: z.string(),
		})
		.meta({ id: 'Changes' });
	api.openAPIRegistry.registerPath({
		method: 'get',
		path: '/changes',
		operationId: 'core.listChanges',
		summary:
			'What changed since a cursor, for the things this caller may see. Without `since`, only the current cursor is given: read everything, then ask from it',
		tags: ['core'],
		security: [{ bearer: [] }],
		request: {
			query: z.object({
				since: z.coerce
					.number()
					.int()
					.min(0)
					.optional()
					.describe('The `cursor` of the last answer'),
			}),
			headers: z.object({ 'x-familyos-on-behalf-of': onBehalfHeader }),
		},
		responses: {
			200: { description: 'The changes', ...json(ChangesSchema) },
			...errorDocs([400, 401, 403, 410, 429]),
		},
	});
	api.get('/changes', async (c) => {
		const actor = c.get('actor');
		const raw = c.req.query('since');
		let since: number | null = null;
		if (raw !== undefined) {
			since = Number(raw);
			if (!Number.isInteger(since) || since < 0)
				throw badFields([{ path: 'since', message: 'A cursor from a previous answer' }]);
		}
		const ctx = await contextOf();
		if (since === null)
			return c.json(
				{ changes: [], cursor: await kernel.changes.head(), more: false, timeZone: ctx.timeZone },
				200,
			);
		const offered = new Set(operations.map((op) => op.extension));
		const page = await kernel.changes.since(since, actor);
		// Core offers no things of its own here but the suggestions this caller may read, named
		// by id alone.
		const drafts = await kernel.runner.visibleDraftIds(
			actor,
			page.changes
				.filter((change) => change.extension === 'core' && change.entity === 'draft')
				.map((change) => change.id),
		);
		const heard = (change: (typeof page.changes)[number]) =>
			change.extension === 'core'
				? change.entity === 'draft' && drafts.has(change.id)
				: offered.has(change.extension) && kernel.features.isOn(change.extension);
		return c.json(
			{
				changes: page.changes.filter(heard).map((change) => ({
					seq: change.seq,
					at: apiInstant(change.at, ctx.timeZone),
					extension: change.extension,
					entity: change.entity,
					id: change.id,
					op: change.op,
				})),
				cursor: page.cursor,
				more: page.more,
				timeZone: ctx.timeZone,
			},
			200,
		);
	});
}
