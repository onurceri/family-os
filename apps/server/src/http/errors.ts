import { ACCESS_REFUSALS, accessRefusalOf } from '@famos/core';
import { ERROR_HTTP_STATUS, type FamosErrorCode, isFamosError, type Logger } from '@famos/sdk';
import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export const ErrorSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: z.unknown().optional(),
	}),
});

/** A refusal: why it was refused, for the app to say in the reader's words. */
const ForbiddenSchema = z.object({
	error: ErrorSchema.shape.error.extend({
		reason: z.enum(ACCESS_REFUSALS).optional(),
		/** The capability that would allow it, when one would. */
		capability: z.string().optional(),
	}),
});

const STATUS = ERROR_HTTP_STATUS as Record<FamosErrorCode, ContentfulStatusCode>;

export const errorResponses = {
	400: { description: 'Invalid request', content: { 'application/json': { schema: ErrorSchema } } },
	401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorSchema } } },
	403: { description: 'Not allowed', content: { 'application/json': { schema: ForbiddenSchema } } },
	404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
	422: {
		description: 'The Idempotency-Key was used for a different action',
		content: { 'application/json': { schema: ErrorSchema } },
	},
	409: { description: 'Conflict', content: { 'application/json': { schema: ErrorSchema } } },
	429: {
		description: 'Limit reached',
		content: { 'application/json': { schema: ErrorSchema } },
	},
} as const;

export function errorBody(code: string, message: string, details?: unknown) {
	return { error: { code, message, ...(details !== undefined && { details }) } };
}

/**
 * Maps errors to responses. Unknown errors never leak details to clients. The log names the
 * matched route pattern, never the raw path: a calendar feed's path is its secret address.
 */
export function handleError(error: unknown, c: Context, logger: Logger): Response {
	if (isFamosError(error)) {
		// A refusal says why in fields of its own, so no app has to read its words.
		const refusal = accessRefusalOf(error);
		if (refusal) {
			logger.debug({ route: c.req.routePath, ...refusal }, 'refused');
			return c.json({ error: { code: error.code, message: error.message, ...refusal } }, 403);
		}
		return c.json(errorBody(error.code, error.message, error.details), STATUS[error.code]);
	}
	logger.error({ err: error, route: c.req.routePath }, 'unhandled error');
	return c.json(errorBody('internal', 'Something went wrong'), 500);
}
