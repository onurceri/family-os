import { type ApiOperation, publicPath } from '@famos/core';
import { type AnyRouteDefinition, FamosError } from '@famos/sdk';
import { HOUR_MS } from '@famos/time';
import { z } from 'zod';
import {
	errorDocs,
	honoPath,
	json,
	onBehalfHeader,
	type PublicParts,
	pascal,
	queryOf,
} from './shared.ts';
import {
	badFields,
	decodeCursor,
	encodeCursor,
	fieldsOf,
	matchesTag,
	PAGE_DEFAULT,
	PAGE_MAX,
	versionTag,
} from './wire.ts';

/** Mounts an extension's read route that is offered to apps, and documents it. */
export function createMountRead(parts: PublicParts) {
	const { api, kernel, contextOf, assertOn } = parts;

	// ───────────── reads ─────────────

	function mountRead(op: ApiOperation, route: AnyRouteDefinition) {
		const { exposure, extension } = op;
		const P = pascal(exposure.name);
		const outSchema: z.ZodType = exposure.output?.schema ?? route.response;
		const isList = outSchema instanceof z.ZodArray;
		const item: z.ZodType = isList ? ((outSchema as z.ZodArray).element as z.ZodType) : outSchema;
		const routeQuery = route.query instanceof z.ZodObject ? route.query : null;
		const queryShape = routeQuery ? routeQuery.shape : {};
		const docQuery = z.object({
			...queryShape,
			...(isList && {
				limit: z.coerce
					.number()
					.int()
					.min(1)
					.max(PAGE_MAX)
					.optional()
					.describe(`How many items at most; ${PAGE_DEFAULT} by default, ${PAGE_MAX} at most`),
				cursor: z.string().optional().describe('The `next` of the previous page'),
			}),
		});
		const success = isList
			? z
					.object({
						items: z.array(item),
						next: z
							.string()
							.nullable()
							.describe('Pass it as `cursor` for the next page; null when this was the last'),
						timeZone: z.string().describe('The family time zone'),
					})
					.meta({ id: `${P}Page` })
			: z.object({ item, timeZone: z.string() }).meta({ id: `${P}Response` });
		const hasQuery = Object.keys(docQuery.shape).length > 0;
		api.openAPIRegistry.registerPath({
			method: 'get',
			path: publicPath(extension, exposure.path),
			operationId: exposure.name,
			summary: exposure.summary,
			tags: [extension],
			security: [{ bearer: [] }],
			request: {
				...(route.params instanceof z.ZodObject && { params: route.params }),
				...(hasQuery && { query: docQuery }),
				headers: z.object({
					'if-none-match': z
						.string()
						.optional()
						.describe('The `ETag` of the last answer; an unchanged one is answered with 304'),
					'x-familyos-on-behalf-of': onBehalfHeader,
				}),
			},
			responses: {
				200: { description: exposure.summary, ...json(success) },
				304: { description: 'Not modified since the `ETag` in `If-None-Match`' },
				...errorDocs([400, 401, 403, 404, 429]),
			},
		});

		api.on('GET', honoPath(publicPath(extension, exposure.path)), async (c) => {
			assertOn(extension);
			const actor = c.get('actor');
			if (!kernel.access.can(actor, route.requires))
				throw new FamosError('forbidden', 'This role may not read this', {
					reason: 'capability',
					capability: route.requires,
				});
			const fields: { path: string; message: string }[] = [];
			let params: unknown;
			if (route.params) {
				const parsed = route.params.safeParse(c.req.param());
				if (!parsed.success) fields.push(...fieldsOf(parsed.error));
				else params = parsed.data;
			}
			const { limit, cursor, ...rest } = queryOf(c);
			let query: unknown;
			if (route.query) {
				const parsed = route.query.safeParse(rest);
				if (!parsed.success) fields.push(...fieldsOf(parsed.error));
				else query = parsed.data;
			}
			let size = PAGE_DEFAULT;
			if (isList && limit !== undefined) {
				const n = Number(limit);
				if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX)
					fields.push({ path: 'limit', message: `A whole number from 1 to ${PAGE_MAX}` });
				else size = n;
			}
			const offset = isList && cursor ? decodeCursor(cursor) : 0;
			if (fields.length > 0) throw badFields(fields);

			const ctx = await contextOf();
			let tag: string | null = null;
			if (isList) {
				// The window is what a list is cut by without a write: the query, the page, the family's
				// settings and the hour (items age out of a list after days, a day ends).
				const window = JSON.stringify({
					p: c.req.path,
					q: Object.entries(rest).sort(),
					size,
					offset,
					tz: ctx.timeZone,
					lang: ctx.language,
					h: Math.floor(kernel.ctx.clock.now() / HOUR_MS),
				});
				tag = `"${await kernel.changes.collectionTag(extension, actor, window)}"`;
				c.header('etag', tag);
				if (matchesTag(c.req.header('if-none-match'), tag)) return c.body(null, 304);
			}
			const result = await route.handle(kernel.contextFor(extension), {
				params,
				query,
				body: undefined,
				actor,
				device: null,
				files: [],
			});
			const shaped = exposure.output ? exposure.output.project(result, ctx) : result;
			if (isList) {
				const all = shaped as unknown[];
				const page = all.slice(offset, offset + size);
				const next = offset + size < all.length ? encodeCursor(offset + size) : null;
				return c.json({ items: page, next, timeZone: ctx.timeZone }, 200);
			}
			const version = (shaped as { version?: unknown } | null)?.version;
			if (typeof version === 'number') {
				const entityTag = versionTag(version);
				c.header('etag', entityTag);
				if (matchesTag(c.req.header('if-none-match'), entityTag)) return c.body(null, 304);
			}
			return c.json({ item: shaped, timeZone: ctx.timeZone }, 200);
		});
	}

	return mountRead;
}
