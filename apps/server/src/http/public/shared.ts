import type { ApiOperation, AppCaller, Kernel } from '@famos/core';
import type { Actor, ApiContext, Logger } from '@famos/sdk';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import type { RateLimiter } from '../rate-limit.ts';
import { badFields, ErrorSchema } from './wire.ts';

/** The public API's address: what is below it is `/<extension>/<path>` of each operation. */
export const PUBLIC_API_BASE = '/api/public/v1';

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

/** What every part of the public API is mounted with. */
export interface PublicParts {
	api: OpenAPIHono<PublicEnv>;
	kernel: Kernel;
	deps: PublicApiDeps;
	/** The family's settings an answer is shaped with. */
	contextOf: () => Promise<ApiContext>;
	/** Refuses a call to an extension that is switched off. */
	assertOn: (extension: string) => void;
	/** The operations, in a stable order so the generated document does not move. */
	operations: readonly ApiOperation[];
	/** The operation's exposure of an action, for the projection of a draft's result. */
	exposureOfAction: ReadonlyMap<string, ApiOperation>;
}

export const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
export const honoPath = (path: string) => path.replace(/\{([^}]+)\}/g, ':$1');
export const pascal = (name: string) =>
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
export function errorDocs(statuses: readonly number[]) {
	return Object.fromEntries(
		statuses.map((status) => [
			status,
			{ description: STATUS_TEXT[status] ?? 'Error', ...json(ErrorSchema) },
		]),
	);
}

export const onBehalfHeader = z
	.string()
	.optional()
	.describe('The member the app acts for; the app must be allowed to');

/** The one JSON object a request body must be; an empty body is an empty object. */
export async function readBody(c: Context): Promise<Record<string, unknown>> {
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

export const queryOf = (c: Context): Record<string, string> =>
	Object.fromEntries(new URL(c.req.url).searchParams);

/** The name of each field of an action input that an operation takes from its path. */
export const fieldOfParam = (op: ApiOperation, name: string) => op.exposure.params?.[name] ?? name;

export const LIST_DRAFTS_SUMMARY =
	'The suggestions that wait for a person to decide, as Quick add lists them for this caller: an app alone sees its own, an app acting for a member sees what that member would see';
