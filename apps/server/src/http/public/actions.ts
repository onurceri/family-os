import {
	type ApiOperation,
	describeField,
	IDEMPOTENCY_KEY,
	pathParams,
	publicPath,
} from '@famos/core';
import type { ActionResult, AnyActionDefinition } from '@famos/sdk';
import { sql } from 'kysely';
import { z } from 'zod';
import {
	errorDocs,
	fieldOfParam,
	honoPath,
	json,
	onBehalfHeader,
	type PublicParts,
	pascal,
	queryOf,
	readBody,
} from './shared.ts';
import { badFields, DraftedSchema, fieldsOf, versionOf, versionTag } from './wire.ts';

/** Mounts an action that is offered to apps as a change, and documents it. */
export function createMountChange(parts: PublicParts) {
	const { api, kernel, contextOf, assertOn } = parts;

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

	return mountChange;
}
