import { accessRefusalOf } from '@famos/core';
import { ERROR_HTTP_STATUS, FamosError, type FamosErrorCode, isFamosError } from '@famos/sdk';
import { z } from 'zod';

/**
 * The shapes the public API shares: errors, the answer to a change, and the cursor of a list.
 * Everything here is part of the contract; within a version it is only added to.
 */

/** Every code an error carries. A stable list: a client may switch on it. */
export const ERROR_CODES = [
	'bad_request',
	'unauthenticated',
	'forbidden',
	'not_found',
	'conflict',
	'limit_reached',
	'feature_off',
	'idempotency_mismatch',
	'precondition_failed',
	'gone',
	'unavailable',
	'internal',
] as const satisfies readonly (FamosErrorCode | 'internal')[];
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z
	.enum(ERROR_CODES)
	.describe(
		'`bad_request` (400): the request is wrong, see `fields`. `unauthenticated` (401): no valid key. `forbidden` (403): the key’s role, or the member it acts for, may not. `not_found` (404). `conflict` (409). `idempotency_mismatch` (422): the Idempotency-Key was used for another request. `precondition_failed` (412): the thing changed since the `If-Match` version. `gone` (410): the changes since that cursor are no longer kept. `limit_reached` (429). `feature_off` (404): the extension is switched off. `unavailable` (503). `internal` (500).',
	)
	.meta({ id: 'ErrorCode' });

export const ErrorSchema = z
	.object({
		error: z.object({
			code: ErrorCodeSchema,
			message: z.string().describe('For people; do not match on it'),
			fields: z
				.array(
					z.object({
						path: z
							.string()
							.describe('The field: a body field, a query or path parameter, or `header:<name>`'),
						message: z.string(),
					}),
				)
				.optional()
				.describe('With `bad_request`: what is wrong, field by field'),
			reason: z
				.string()
				.optional()
				.describe(
					'With `forbidden`: `capability` (the role lacks it), `approval`, `critical`, `on_behalf` (the app may not act for that member)',
				),
			capability: z
				.string()
				.optional()
				.describe('With `forbidden`: the capability that would allow it'),
			currentVersion: z
				.number()
				.int()
				.optional()
				.describe('With `precondition_failed`: the version the thing has now'),
		}),
	})
	.meta({ id: 'Error' });
export type ErrorBody = z.infer<typeof ErrorSchema>;

export type Field = { path: string; message: string };

/** The fields a request is wrong in, from a validation failure. */
export function fieldsOf(error: z.ZodError, prefix = ''): Field[] {
	return error.issues.map((issue) => {
		const path = issue.path.reduce<string>(
			(text, part) =>
				typeof part === 'number'
					? `${text}[${part}]`
					: text
						? `${text}.${String(part)}`
						: String(part),
			'',
		);
		return { path: path || prefix, message: issue.message };
	});
}

/** A request that is wrong, with the fields it is wrong in. */
export function badFields(fields: Field[], message = 'The request is not valid'): FamosError {
	return new FamosError('bad_request', message, { fields });
}

/** The HTTP status and body of an error. Unknown errors say nothing of what went wrong. */
export function errorResponse(error: unknown): { status: number; body: ErrorBody } {
	if (!isFamosError(error))
		return {
			status: 500,
			body: { error: { code: 'internal', message: 'Something went wrong' } },
		};
	const status = ERROR_HTTP_STATUS[error.code];
	const details = (error.details ?? {}) as Record<string, unknown>;
	const out: ErrorBody['error'] = { code: error.code, message: error.message };
	if (error.code === 'bad_request' && Array.isArray(details.fields))
		out.fields = details.fields as Field[];
	const refusal = accessRefusalOf(error);
	if (refusal) {
		out.reason = refusal.reason;
		if (refusal.capability) out.capability = refusal.capability;
	} else if (error.code === 'forbidden' && typeof details.reason === 'string') {
		out.reason = details.reason;
	}
	if (error.code === 'precondition_failed' && typeof details.version === 'number')
		out.currentVersion = details.version;
	return { status, body: { error: out } };
}

/** The answer to a change that waits for a person to approve it. */
export const DraftedSchema = z
	.object({
		status: z.literal('drafted'),
		draftId: z.string().describe('Read how it ended at `GET /drafts/{draftId}`'),
		timeZone: z.string(),
	})
	.meta({ id: 'Drafted' });

/** Default and largest page of a list. */
export const PAGE_DEFAULT = 100;
export const PAGE_MAX = 500;

/** A cursor is an opaque string: where the next page starts. */
export function encodeCursor(offset: number): string {
	return Buffer.from(String(offset)).toString('base64url');
}

export function decodeCursor(cursor: string): number {
	const offset = Number(Buffer.from(cursor, 'base64url').toString());
	if (!Number.isInteger(offset) || offset < 0)
		throw badFields([{ path: 'cursor', message: 'Not a cursor from a previous page' }]);
	return offset;
}

/** `If-Match` / `ETag` value of an entity: its version. */
export const versionTag = (version: number): string => `"v${version}"`;

/** The version an `If-Match` names (`"v3"`, `v3`, `"3"` or `3`), or null when it names none. */
export function versionOf(header: string | undefined): number | null {
	if (header === undefined) return null;
	const match = /^\s*(?:W\/)?"?v?(\d+)"?\s*$/.exec(header);
	return match ? Number(match[1]) : null;
}

/** Whether an `If-None-Match` header holds the tag (or `*`). */
export function matchesTag(header: string | undefined, tag: string): boolean {
	if (header === undefined) return false;
	return header
		.split(',')
		.map((part) => part.trim().replace(/^W\//, ''))
		.some((part) => part === '*' || part === tag);
}
