import { z } from 'zod';
import type { Actor } from './actor.ts';
import type { ApiExposure } from './api.ts';
import type { ExtensionContext } from './context.ts';

/**
 * Framework-neutral HTTP route definitions. Extensions never import an HTTP framework; the
 * server's HTTP adapter turns these into OpenAPI routes. State changes belong in
 * actions — routes are for reads and for inbound flows that delegate to actions.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A stored file sent back as the response body (images in the Inbox, documents). */
export interface FileResponse {
	stream: AsyncIterable<Uint8Array>;
	contentType: string;
	size: number;
	filename: string;
	/** Defaults to `private, no-store`; a proxy of third-party content may allow short caching. */
	cacheControl?: string;
}

/**
 * Use as a route's `response` to send a file instead of JSON. The server only renders images and
 * PDFs inline, sends everything else as a download, and sandboxes the response, so a shared file
 * can never run as part of the app.
 */
export const FileResponseSchema = z.custom<FileResponse>(
	(value) =>
		typeof value === 'object' && value !== null && 'stream' in value && 'contentType' in value,
);

/** A short text document sent as the response body (for example an ICS calendar feed). */
export interface TextResponse {
	text: string;
	/**
	 * Only `text/calendar`, `text/css` (the generated theme stylesheet), `text/plain`
	 * and `application/json` are sent as such; anything else becomes `text/plain`.
	 */
	contentType: string;
	/** Defaults to `private, no-store`. */
	cacheControl?: string;
	/** A validator (quoted, e.g. `"1.0.0"`): a request that already has it gets `304 Not Modified`. */
	etag?: string;
}

/**
 * Use as a route's `response` to send text with its own content type instead of JSON. The server
 * adds `nosniff` and a sandboxing CSP, so the text can never run as part of the app.
 */
export const TextResponseSchema = z.custom<TextResponse>(
	(value) =>
		typeof value === 'object' && value !== null && 'text' in value && 'contentType' in value,
);

/** A device an admin marked as a family device (kitchen tablet, child's phone). */
export interface TrustedDevice {
	id: string;
	name: string;
}

/** A file received by an upload route. Read it once (stream or bytes). */
export interface UploadedFile {
	/** Form field name. */
	field: string;
	name: string;
	type: string;
	size: number;
	stream(): AsyncIterable<Uint8Array>;
	bytes(): Promise<Uint8Array>;
}

/** Turns a route into a multipart/form-data upload. Text fields are validated by `body`. */
export interface UploadSpec {
	/** Maximum total request size in bytes. */
	maxBytes: number;
	maxFiles: number;
	/** Accepted MIME types; `image/*` style wildcards allowed. */
	accept: readonly string[];
}

export interface RouteRequest<P, Q, B> {
	params: P;
	query: Q;
	body: B;
	actor: Actor;
	/** The trusted device the request comes from, if any. */
	device: TrustedDevice | null;
	/** Files of an upload route (empty otherwise). */
	files: readonly UploadedFile[];
}

/**
 * Who may call a route:
 * - `public`: anyone (no session needed),
 * - `trusted-device`: a signed-in member, or any request from a trusted family device (never a display),
 * - `signedIn`: any signed-in member (never a display),
 * - a capability id: members whose role grants it, or a paired display that was granted
 *   it (view-level capabilities only).
 */
export type RouteAccess = 'public' | 'trusted-device' | 'signedIn' | (string & {});

export interface RouteDefinition<
	Params extends z.ZodType = z.ZodType,
	Query extends z.ZodType = z.ZodType,
	Body extends z.ZodType = z.ZodType,
	Res extends z.ZodType = z.ZodType,
> {
	readonly method: HttpMethod;
	/** Path relative to `/api/v1/<extension>`, using `{param}` syntax, e.g. `/lists/{listId}`. */
	readonly path: string;
	/** Stable, globally unique, e.g. `shopping.listItems`. Client SDK method names derive from it. */
	readonly operationId: string;
	readonly summary: string;
	readonly requires: RouteAccess;
	readonly params?: Params;
	readonly query?: Query;
	readonly body?: Body;
	/** Makes this a multipart upload route; `body` then validates the text fields. */
	readonly upload?: UploadSpec;
	readonly response: Res;
	/** Status code for a successful response. */
	readonly status?: 200 | 201 | 202 | 204;
	/**
	 * Offers this read on the public API (`/api/public/v1`) as a `GET`. Only a read of data (a JSON
	 * response, never a file, text or upload) whose `requires` is a capability can be offered.
	 */
	readonly expose?: ApiExposure;
	handle(
		ctx: ExtensionContext,
		request: RouteRequest<z.infer<Params>, z.infer<Query>, z.infer<Body>>,
	): Promise<z.infer<Res>>;
}

export function defineRoute<
	Params extends z.ZodType = z.ZodUndefined,
	Query extends z.ZodType = z.ZodUndefined,
	Body extends z.ZodType = z.ZodUndefined,
	Res extends z.ZodType = z.ZodType,
>(
	definition: RouteDefinition<Params, Query, Body, Res>,
): RouteDefinition<Params, Query, Body, Res> {
	return definition;
}

// biome-ignore lint/suspicious/noExplicitAny: registries hold heterogeneous route types.
export type AnyRouteDefinition = RouteDefinition<any, any, any, any>;
