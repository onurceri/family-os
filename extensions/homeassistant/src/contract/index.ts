import { z } from 'zod';
import { normalizeBaseUrl } from './url.ts';

export { type BaseUrl, normalizeBaseUrl } from './url.ts';

/**
 * Home Assistant contract: the connection the family made and what the check found out.
 */

/** What the last check found: `checking` until the job has answered. */
export const CONNECTION_STATUSES = [
	'checking',
	'ok',
	'token_refused',
	'not_home_assistant',
	'unreachable',
	'blocked_address',
	'timeout',
	'failed',
] as const;
export const ConnectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

/** A long-lived access token: one word, as Home Assistant shows it. */
export const TokenSchema = z
	.string()
	.trim()
	.min(1)
	.max(1024)
	.regex(/^\S+$/, 'A token has no spaces');

export const AddressSchema = z
	.string()
	.max(2000)
	.refine((value) => normalizeBaseUrl(value) !== null, {
		message: 'Use an http or https address without a user name, query or fragment',
	});

export const ConnectInputSchema = z.object({
	url: AddressSchema,
	token: TokenSchema,
});
export type ConnectInput = z.infer<typeof ConnectInputSchema>;

/** The address without anything that could be a secret in it. */
export const ConnectionAddressSchema = z.object({
	scheme: z.enum(['http', 'https']),
	host: z.string(),
	port: z.number().int().nullable(),
	path: z.string().nullable(),
});
export type ConnectionAddress = z.infer<typeof ConnectionAddressSchema>;

/** The connection as the API shows it: never the token. */
export const ConnectionSchema = z.discriminatedUnion('connected', [
	z.object({ connected: z.literal(false) }),
	z.object({
		connected: z.literal(true),
		address: ConnectionAddressSchema,
		status: ConnectionStatusSchema,
		checkedAt: z.number().int().nullable(),
		version: z.string().nullable(),
		name: z.string().nullable(),
	}),
]);
export type Connection = z.infer<typeof ConnectionSchema>;

export const connectionChangedPayload = z.object({});
