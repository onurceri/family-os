import {
	type ApiOperation,
	type AppCaller,
	CORE_CAPABILITIES,
	type CoreTables,
	type DraftRow,
	describeField,
	IDEMPOTENCY_KEY,
	type Kernel,
	pathParams,
	publicPath,
	WAITING_STATUSES,
} from '@famos/core';
import {
	type ActionResult,
	type Actor,
	type AnyActionDefinition,
	type AnyRouteDefinition,
	type ApiContext,
	apiInstant,
	appOf,
	FamosError,
	type Logger,
	memberBehind,
	principalOf,
} from '@famos/sdk';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { sql } from 'kysely';
import { z } from 'zod';
import { authenticateApp } from '../authenticate.ts';
import type { AppEnv } from '../env.ts';
import { createRateLimiter, type RateLimiter } from '../rate-limit.ts';
import {
	badFields,
	DraftedSchema,
	decodeCursor,
	ErrorSchema,
	encodeCursor,
	errorResponse,
	type Field,
	fieldsOf,
	matchesTag,
	PAGE_DEFAULT,
	PAGE_MAX,
	versionOf,
	versionTag,
} from './wire.ts';

/** The public API's address: what is below it is `/<extension>/<path>` of each operation. */
export const PUBLIC_API_BASE = '/api/public/v1';

/** Requests per app per minute: a program polling a few lists every few seconds stays far below. */
export const PUBLIC_RATE_PER_MINUTE = 300;
/** Wrong or missing keys per client address per minute (shared with the MCP endpoint). */
export const MAX_BAD_KEYS_PER_MINUTE = 30;
/** What the API reads of a change: small JSON, never files. */
const MAX_BODY_BYTES = 256 * 1024;

export const PUBLIC_OPENAPI_INFO = {
	openapi: '3.1.0',
	info: {
		title: 'FamilyOS API',
		version: 'v1',
		description:
			'The API connected apps use. Generated from what the extensions offer; do not edit. Authenticate with `Authorization: Bearer <key>` (a key from Settings, Connected apps); add `X-FamilyOS-On-Behalf-Of: <member id>` to act for a member the app may act for. Every answer carries the family `timeZone`, instants are RFC 3339 with an offset and days are `YYYY-MM-DD`. Within v1 operations and fields are only added.',
	},
	servers: [{ url: PUBLIC_API_BASE, description: 'This FamilyOS server' }],
};

export type PublicEnv = {
	Variables: { actor: Actor; caller: AppCaller };
};

export interface PublicApiDeps {
	kernel: Kernel;
	logger: Logger;
	appVersion: string;
	/** The client address, for the limit on wrong keys. */
	clientIp: (c: Context) => string;
	/** Wrong keys per address, shared with the other bearer door. */
	badTokens?: RateLimiter;
}

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const honoPath = (path: string) => path.replace(/\{([^}]+)\}/g, ':$1');
const pascal = (name: string) =>
	name
		.split('.')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join('');

const STATUS_TEXT: Record<number, string> = {
	400: 'The request is not valid (see `fields`)',
	401: 'No valid key',
	403: 'The key’s role, or the member it acts for, may not',
	404: 'Not found, or the extension is switched off',
	409: 'Conflict with the state of the thing',
	410: 'No longer kept',
	412: 'The thing changed since the version in `If-Match`',
	422: 'The Idempotency-Key was used for another request',
	429: 'Too many requests (see `Retry-After`)',
};

/** The error answers of an operation, by status. */
function errorDocs(statuses: readonly number[]) {
	return Object.fromEntries(
		statuses.map((status) => [
			status,
			{ description: STATUS_TEXT[status] ?? 'Error', ...json(ErrorSchema) },
		]),
	);
}

const onBehalfHeader = z
	.string()
	.optional()
	.describe('The member the app acts for; the app must be allowed to');

/** The one JSON object a request body must be; an empty body is an empty object. */
async function readBody(c: Context): Promise<Record<string, unknown>> {
	const text = await c.req.text();
	if (text.trim() === '') return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw badFields([{ path: 'body', message: 'The body is not valid JSON' }]);
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw badFields([{ path: 'body', message: 'The body must be a JSON object' }]);
	return value as Record<string, unknown>;
}

const queryOf = (c: Context): Record<string, string> =>
	Object.fromEntries(new URL(c.req.url).searchParams);

/** The name of each field of an action input that an operation takes from its path. */
const fieldOfParam = (op: ApiOperation, name: string) => op.exposure.params?.[name] ?? name;

export function createPublicApi(deps: PublicApiDeps): OpenAPIHono<PublicEnv> {
	const { kernel } = deps;
	const api = new OpenAPIHono<PublicEnv>();
	const perApp = createRateLimiter({ max: PUBLIC_RATE_PER_MINUTE, windowMs: 60_000 });
	const badTokens =
		deps.badTokens ?? createRateLimiter({ max: MAX_BAD_KEYS_PER_MINUTE, windowMs: 60_000 });

	api.onError((error, c) => {
		const { status, body } = errorResponse(error);
		if (status === 500)
			deps.logger.error({ err: error, route: c.req.routePath }, 'unhandled error');
		if (status === 429 && !c.res.headers.has('retry-after')) c.header('retry-after', '60');
		return c.json(body, status as 400);
	});
	api.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

	// Bearer only: the credential is read from the Authorization header and nowhere else, so a
	// cookie a browser holds does nothing here and the API has no request forgery to defend from.
	api.use(
		'*',
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: (c) => {
				const { body } = errorResponse(
					badFields([{ path: 'body', message: `At most ${MAX_BODY_BYTES / 1024} KB` }]),
				);
				return c.json(body, 400);
			},
		}),
	);
	api.use('*', async (c, next) => {
		const result = await authenticateApp(kernel, c.req.raw.headers);
		if (result.outcome === 'paused') {
			// The key is right, so this is no wrong guess to count; the app is told to wait, not to
			// ask for a new key.
			c.header('www-authenticate', 'Bearer realm="FamilyOS"');
			throw new FamosError(
				'unauthenticated',
				'This app is paused in FamilyOS; it works again when it is resumed',
				{ reason: 'paused' },
			);
		}
		if (result.outcome !== 'ok') {
			if (!badTokens.hit(deps.clientIp(c))) {
				c.header('retry-after', '60');
				throw new FamosError('limit_reached', 'Too many failed attempts; try again in a minute');
			}
			c.header('www-authenticate', 'Bearer realm="FamilyOS"');
			throw new FamosError(
				'unauthenticated',
				result.outcome === 'missing'
					? 'Send an Authorization: Bearer header with an app key'
					: 'The key is unknown, expired or revoked',
			);
		}
		const { caller } = result;
		if (!perApp.hit(caller.app.id)) {
			c.header('retry-after', '60');
			throw new FamosError('limit_reached', 'Too many requests; try again in a minute');
		}
		// Only a permitted use counts as one.
		await kernel.apps.touch(caller.tokenId);
		c.set('actor', caller.actor);
		c.set('caller', caller);
		await next();
	});

	api.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
		type: 'http',
		scheme: 'bearer',
		description: 'An app key from Settings, Connected apps',
	});

	/** The family's settings an answer is shaped with. */
	async function contextOf(): Promise<ApiContext> {
		const settings = await kernel.ctx.family.settings();
		return {
			timeZone: settings.timeZone,
			language: settings.locale,
			translate: (key, params) => kernel.translate(settings.locale, key, params),
		};
	}

	function assertOn(extension: string) {
		if (!kernel.features.isOn(extension))
			throw new FamosError('feature_off', `${extension} is switched off`);
	}

	// The operations, in a stable order so the generated document does not move.
	const operations = [...kernel.registry.apiOperations].sort(
		(a, b) =>
			a.extension.localeCompare(b.extension) ||
			a.exposure.path.localeCompare(b.exposure.path) ||
			a.exposure.method.localeCompare(b.exposure.method),
	);
	/** The operation's exposure of an action, for the projection of a draft's result. */
	const exposureOfAction = new Map<string, ApiOperation>();
	for (const op of operations)
		if (op.source.kind === 'action' && !exposureOfAction.has(op.source.action.id))
			exposureOfAction.set(op.source.action.id, op);

	for (const op of operations) {
		if (op.source.kind === 'route') mountRead(op, op.source.route);
		else mountChange(op, op.source.action);
	}

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
					h: Math.floor(kernel.ctx.clock.now() / 3_600_000),
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

	// ───────────── changes ─────────────

	function mountChange(op: ApiOperation, action: AnyActionDefinition) {
		const { exposure, extension } = op;
		const P = pascal(exposure.name);
		const shape = (action.input as z.ZodObject).shape as Record<string, z.ZodType>;
		const names = pathParams(exposure.path);
		const fromPath = new Set(names.map((n) => fieldOfParam(op, n)));
		const fixed = exposure.fixed ?? {};
		const skipped = new Set([...fromPath, ...Object.keys(fixed), ...(exposure.omit ?? [])]);
		let own: Record<string, z.ZodType> = {};
		for (const [field, schema] of Object.entries(shape)) {
			if (skipped.has(field)) continue;
			const text = exposure.describe?.[field];
			own[field] = text ? schema.describe(text) : schema;
		}
		// A description for a field inside another (`items.quantity`) goes in the same way.
		for (const [key, text] of Object.entries(exposure.describe ?? {})) {
			if (!key.includes('.')) continue;
			const described = describeField(z.object(own), key.split('.'), text);
			if (described instanceof z.ZodObject) own = described.shape as Record<string, z.ZodType>;
		}
		const inQuery = exposure.method === 'delete';
		const hasOwn = Object.keys(own).length > 0;
		const needsMatch = exposure.method === 'put';
		const created = /^[a-z]+\.(create|add)/.test(exposure.name);
		const outSchema: z.ZodType = exposure.output?.schema ?? action.output;
		const applied = z
			.object({
				status: z.literal('applied'),
				result: outSchema,
				timeZone: z.string().describe('The family time zone'),
			})
			.meta({ id: `${P}Result` });
		// A part of the path cannot be left out, whatever the action's field says, and it is described
		// for the program as the body's fields are.
		const pathPart = (name: string): z.ZodType => {
			const field = fieldOfParam(op, name);
			let schema = shape[field] as z.ZodType;
			while (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)
				schema = schema.unwrap() as z.ZodType;
			const text = exposure.describe?.[field];
			return text ? schema.describe(text) : schema;
		};
		const pathSchema = names.length
			? z.object(Object.fromEntries(names.map((n) => [n, pathPart(n)])))
			: null;
		api.openAPIRegistry.registerPath({
			method: exposure.method,
			path: publicPath(extension, exposure.path),
			operationId: exposure.name,
			summary: exposure.summary,
			tags: [extension],
			security: [{ bearer: [] }],
			request: {
				...(pathSchema && { params: pathSchema }),
				...(inQuery && hasOwn && { query: z.object(own) }),
				...(!inQuery &&
					hasOwn && {
						body: {
							...json(z.object(own).meta({ id: `${P}Request` })),
							required: Object.values(own).some((s) => !s.safeParse(undefined).success),
						},
					}),
				headers: z.object({
					'idempotency-key': z
						.string()
						.optional()
						.describe(
							'Makes the request safe to repeat (1-100 characters: letters, digits, `_`, `-`). The same key for the same request returns the first answer (header `Idempotent-Replayed: true`); for another request it is refused with 422',
						),
					'if-match': needsMatch
						? z
								.string()
								.describe(
									'The `version` (or `ETag`) of what you read; refused with 412 if it moved on',
								)
						: z
								.string()
								.optional()
								.describe(
									'The `version` (or `ETag`) of what you read; refused with 412 if it moved on',
								),
					'x-familyos-on-behalf-of': onBehalfHeader,
				}),
			},
			responses: {
				[created ? 201 : 200]: { description: 'Applied', ...json(applied) },
				202: {
					description:
						'Waits for a person to approve it (the app only suggests, or the role may only suggest)',
					...json(DraftedSchema),
				},
				...errorDocs([400, 401, 403, 404, 409, 412, 422, 429]),
			},
		});

		api.on(
			exposure.method.toUpperCase(),
			honoPath(publicPath(extension, exposure.path)),
			async (c) => {
				assertOn(extension);
				const actor = c.get('actor');
				const given = inQuery ? queryOf(c) : await readBody(c);
				const input: Record<string, unknown> = {};
				for (const [field, value] of Object.entries(given))
					if (!skipped.has(field)) input[field] = value;
				const raw = c.req.param() as Record<string, string>;
				for (const name of names) input[fieldOfParam(op, name)] = raw[name];
				Object.assign(input, fixed);

				const fields: { path: string; message: string }[] = [];
				const parsed = action.input.safeParse(input);
				if (!parsed.success) fields.push(...fieldsOf(parsed.error));
				const matchHeader = c.req.header('if-match');
				const ifMatch = versionOf(matchHeader);
				if (matchHeader !== undefined && ifMatch === null)
					fields.push({
						path: 'header:if-match',
						message: 'Send the `version` of what you read, or its `ETag`',
					});
				if (needsMatch && matchHeader === undefined)
					fields.push({
						path: 'header:if-match',
						message: 'Required to replace a whole record: send the `version` you read',
					});
				const key = c.req.header('idempotency-key');
				if (key !== undefined && !IDEMPOTENCY_KEY.test(key))
					fields.push({
						path: 'header:idempotency-key',
						message: '1-100 characters: letters, digits, `_` and `-`',
					});
				if (fields.length > 0) throw badFields(fields);

				let replayed = false;
				const outcome: ActionResult<unknown> = await kernel.runner.invoke(action.id, input, actor, {
					...(key !== undefined && {
						idempotencyKey: key,
						onReplay: () => {
							replayed = true;
						},
					}),
					...(ifMatch !== null && { ifMatch }),
				});
				if (replayed) c.header('idempotent-replayed', 'true');
				const ctx = await contextOf();
				if (outcome.status === 'drafted')
					return c.json(
						{ status: 'drafted', draftId: outcome.draftId, timeZone: ctx.timeZone },
						202,
					);

				let result = exposure.output
					? exposure.output.project(outcome.output, ctx)
					: outcome.output;
				// What the action returned was read before its last update: the version the answer names
				// is the one the row has now (the row may be a new one the change made, as a date split
				// out of a repeating event).
				const shaped = result as { id?: unknown; version?: unknown } | null;
				if (
					!replayed &&
					exposure.method !== 'delete' &&
					shaped !== null &&
					typeof shaped === 'object' &&
					typeof shaped.id === 'string' &&
					typeof shaped.version === 'number'
				) {
					// An action that adds a row names no row beforehand: its answer is the row as made.
					const version = (await rowVersion(action, input, shaped.id)) ?? shaped.version;
					result = { ...shaped, version };
					c.header('etag', versionTag(version));
				}
				return c.json({ status: 'applied', result, timeZone: ctx.timeZone }, created ? 201 : 200);
			},
		);
	}

	/** The version a row of the table an action works on has now; null when it has none. */
	async function rowVersion(
		action: AnyActionDefinition,
		input: unknown,
		id: string,
	): Promise<number | null> {
		const target = action.target?.(input);
		if (!target?.versionColumn) return null;
		const out = await sql<{
			v: number;
		}>`select ${sql.id(target.versionColumn)} as v from ${sql.id(target.table)} where id = ${id}`.execute(
			kernel.ctx.db,
		);
		return out.rows[0]?.v ?? null;
	}

	// ───────────── discovery, drafts, changes ─────────────

	const LIST_DRAFTS_SUMMARY =
		'The suggestions that wait for a person to decide, as Quick add lists them for this caller: an app alone sees its own, an app acting for a member sees what that member would see';
	const Method = z.enum(['get', 'post', 'put', 'patch', 'delete']);
	const DiscoverySchema = z
		.object({
			api: z.literal('v1'),
			familyOS: z.string().describe('The version of this FamilyOS server'),
			timeZone: z.string().describe('The family time zone'),
			language: z.string().describe('The family language'),
			caller: z.object({
				app: z.object({ id: z.string(), name: z.string(), mode: z.enum(['apply', 'suggest']) }),
				memberId: z
					.string()
					.nullable()
					.describe('The member this request acts for, if it named one'),
			}),
			actsFor: z
				.array(z.object({ memberId: z.string(), name: z.string() }))
				.describe(
					'The active members this app may act for: send one `memberId` in `X-FamilyOS-On-Behalf-Of` to act as that person',
				),
			extensions: z.array(
				z.object({
					id: z.string(),
					version: z.string(),
					enabled: z.boolean().describe('False when it is switched off in Settings'),
				}),
			),
			operations: z
				.array(
					z.object({
						name: z.string().describe('The operation’s `operationId`'),
						method: Method,
						path: z.string().describe('The full path, with `{param}` for the parts that vary'),
						summary: z.string(),
						outcome: z
							.enum(['read', 'apply', 'draft'])
							.describe(
								'What a call does for this caller now: `read`; `apply` the change is made; `draft` it waits for a person to approve it',
							),
					}),
				)
				.describe(
					'Only what this caller may use now: the app’s role, and the member it acts for, decide',
				),
		})
		.meta({ id: 'Discovery' });

	api.openAPIRegistry.registerPath({
		method: 'get',
		path: '/',
		operationId: 'core.discover',
		summary:
			'What this server offers this caller: versions, the family, the extensions and the operations the caller may use now',
		tags: ['core'],
		security: [{ bearer: [] }],
		request: { headers: z.object({ 'x-familyos-on-behalf-of': onBehalfHeader }) },
		responses: {
			200: { description: 'The discovery document', ...json(DiscoverySchema) },
			...errorDocs([401, 403, 429]),
		},
	});
	api.get('/', async (c) => {
		const actor = c.get('actor');
		const caller = c.get('caller');
		const settings = await kernel.ctx.family.settings();
		const active = new Map((await kernel.ctx.family.members()).map((m) => [m.id as string, m]));
		const actsFor = caller.actsFor.flatMap((id) => {
			const member = active.get(id);
			return member ? [{ memberId: member.id as string, name: member.displayName }] : [];
		});
		const decisions = kernel.runner.decisions(actor);
		const usable: z.infer<typeof DiscoverySchema>['operations'] = [];
		for (const op of operations) {
			if (!kernel.features.isOn(op.extension)) continue;
			let outcome: 'read' | 'apply' | 'draft';
			if (op.source.kind === 'route') {
				if (!kernel.access.can(actor, op.source.route.requires)) continue;
				outcome = 'read';
			} else {
				const decision = decisions[op.source.action.id];
				if (!decision || decision.outcome === 'refuse') continue;
				outcome = decision.outcome;
			}
			usable.push({
				name: op.exposure.name,
				method: op.exposure.method,
				path: `${PUBLIC_API_BASE}${publicPath(op.extension, op.exposure.path)}`,
				summary: op.exposure.summary,
				outcome,
			});
		}
		// The suggestions it may read are core's own route, not an extension's, so they are named here.
		if (kernel.access.can(actor, CORE_CAPABILITIES.draftsPropose.id))
			usable.push({
				name: 'core.listDrafts',
				method: 'get',
				path: `${PUBLIC_API_BASE}/drafts`,
				summary: LIST_DRAFTS_SUMMARY,
				outcome: 'read',
			});
		return c.json(
			{
				api: 'v1' as const,
				familyOS: deps.appVersion,
				timeZone: settings.timeZone,
				language: settings.locale,
				caller: {
					app: {
						id: caller.app.id,
						name: caller.app.name,
						mode: appOf(actor)?.mode ?? 'apply',
					},
					memberId: caller.memberId,
				},
				actsFor,
				extensions: kernel.registry.extensions
					.filter((ext) => ext.id !== 'core')
					.map((ext) => ({
						id: ext.id,
						version: ext.manifest.version,
						enabled: kernel.features.isOn(ext.id),
					})),
				operations: usable,
			},
			200,
		);
	});

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
		const rows = await waitingFor(actor);
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

	/**
	 * The suggestions still waiting that this caller sees, newest first: what Quick add lists a
	 * member (their own, and those they may decide). An app alone sees the ones it made; an app
	 * acting for a member sees that member's view, within the app's own capabilities.
	 */
	async function waitingFor(actor: Actor): Promise<DraftRow[]> {
		const member = memberBehind(actor);
		const all = await kernel.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.selectAll()
			.where('status', 'in', [...WAITING_STATUSES])
			.where((eb) =>
				member !== null
					? eb.or([eb('for_member', 'is', null), eb('for_member', '=', member)])
					: eb('for_member', 'is', null),
			)
			.orderBy('created_at', 'desc')
			.orderBy('id', 'desc')
			.execute();
		const runner = kernel.runner;
		const seen = all.filter((row) => draftVisibleTo(actor, row));
		// One about a day that has passed, or about something that is gone, no longer waits.
		const passed = await runner.passedCheck();
		const open = seen.filter((row) => !passed(row));
		const gone = await runner.goneAmong(open);
		return open.filter((row) => !gone.has(row.id));
	}

	/**
	 * Whether this caller sees a suggestion: a person as they are in the app (theirs, or theirs to
	 * decide), any other caller only what it made itself.
	 */
	function draftVisibleTo(actor: Actor, row: DraftRow): boolean {
		const member = memberBehind(actor);
		if (row.for_member !== null && row.for_member !== member) return false;
		if (actor.kind === 'member') {
			const runner = kernel.runner;
			const { via: _via, ...person } = actor;
			return (
				runner.mayDecide(row, person) ||
				runner.isProposer(person, row) ||
				(runner.unavailable(row) !== null &&
					kernel.access.can(person, CORE_CAPABILITIES.draftsApprove.id))
			);
		}
		return principalOf(JSON.parse(row.proposed_by) as Actor) === principalOf(actor);
	}

	/** The ids among these suggestions that this caller sees: the only core things the feed names. */
	async function visibleDraftIds(actor: Actor, ids: readonly string[]): Promise<Set<string>> {
		if (ids.length === 0) return new Set();
		if (!kernel.access.can(actor, CORE_CAPABILITIES.draftsPropose.id)) return new Set();
		const rows = await kernel.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_drafts')
			.selectAll()
			.where('id', 'in', [...ids])
			.execute();
		return new Set(rows.filter((row) => draftVisibleTo(actor, row)).map((row) => row.id));
	}

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
		const drafts = await visibleDraftIds(
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

	// The document of what this server offers, for a program that builds its client from it. It
	// names the installed extensions, so it takes a key like everything else here.
	let document: ReturnType<typeof api.getOpenAPI31Document> | undefined;
	api.get('/openapi.json', (c) => {
		document ??= api.getOpenAPI31Document(PUBLIC_OPENAPI_INFO);
		return c.json(document);
	});

	return api;
}

/** Mounts the public API on the server's app, below `/api/public/v1`. */
export function mountPublicApi(app: OpenAPIHono<AppEnv>, deps: PublicApiDeps): void {
	const api = createPublicApi(deps);
	// Hono's own copy of the request reads `duplex` from the server's request object, which is not
	// a real `Request` and refuses it, so every call with a body failed. Built from its parts here.
	app.mount(PUBLIC_API_BASE, api.fetch, {
		replaceRequest: (request) => {
			const url = new URL(request.url);
			url.pathname = url.pathname.slice(PUBLIC_API_BASE.length) || '/';
			const bodyless = request.method === 'GET' || request.method === 'HEAD';
			return new Request(url, {
				method: request.method,
				headers: request.headers,
				...(!bodyless && { body: request.body, duplex: 'half' }),
			});
		},
	});
}

/** The document of the public API (`public-openapi.json`). */
export function publicOpenApiDocument(deps: PublicApiDeps) {
	return createPublicApi(deps).getOpenAPI31Document(PUBLIC_OPENAPI_INFO);
}
