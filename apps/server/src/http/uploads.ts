import { mimeAccepted } from '@famos/core';
import {
	type AnyRouteDefinition,
	FamosError,
	type UploadedFile,
	type UploadSpec,
} from '@famos/sdk';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { errorBody } from './errors.ts';

/**
 * Multipart uploads for routes that declare `upload` (framework-neutral in the SDK).
 * Size limits are enforced per route before the body is read; files are validated for count,
 * type and size; text fields are validated with the route's `body` schema.
 */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;
/** A language pack (at most 2 MB) plus the request around it. */
export const LANGUAGE_PACK_BODY_LIMIT = 2 * 1024 * 1024 + 4096;

/** A theme pack (at most 1.5 MB decoded, a third more as base64) plus the request around it. */
export const THEME_PACK_BODY_LIMIT = 2 * 1024 * 1024 + 4096;

function toUploaded(field: string, file: File): UploadedFile {
	return {
		field,
		name: file.name || 'file',
		type: file.type || 'application/octet-stream',
		size: file.size,
		stream: () => file.stream() as unknown as AsyncIterable<Uint8Array>,
		bytes: async () => new Uint8Array(await file.arrayBuffer()),
	};
}

export async function readUpload(
	c: Context,
	def: AnyRouteDefinition & { upload: UploadSpec },
): Promise<{ body: unknown; files: UploadedFile[] }> {
	if (!c.req.header('content-type')?.startsWith('multipart/form-data')) {
		throw new FamosError('bad_request', 'Expected multipart/form-data');
	}
	const form = await c.req.parseBody({ all: true });
	const fields: Record<string, string> = {};
	const files: UploadedFile[] = [];
	for (const [name, value] of Object.entries(form)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			if (item instanceof File) files.push(toUploaded(name, item));
			else if (typeof item === 'string') fields[name] = item;
		}
	}
	if (files.length > def.upload.maxFiles) {
		throw new FamosError('bad_request', `At most ${def.upload.maxFiles} files are allowed`);
	}
	const rejected = files.find((f) => !mimeAccepted(f.type, def.upload.accept));
	if (rejected) throw new FamosError('bad_request', `File type ${rejected.type} is not accepted`);

	let body: unknown;
	if (def.body) {
		const parsed = def.body.safeParse(fields);
		if (!parsed.success)
			throw new FamosError('bad_request', 'Invalid request', z.treeifyError(parsed.error));
		body = parsed.data;
	}
	return { body, files };
}

/** Converts `/inbox/{id}/files` style paths to a matcher for incoming request paths. */
function pathMatcher(path: string): RegExp {
	const escaped = path
		.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
		.replace(/\\\{[^}]+\\\}|\{[^}]+\}/g, '[^/]+');
	return new RegExp(`^${escaped}$`);
}

/**
 * One body-size middleware for the whole API: upload routes get their own limit, everything
 * else the default. A single middleware avoids a global limit rejecting legitimate uploads.
 */
export function bodyLimits(
	uploads: readonly { method: string; path: string; maxBytes: number }[],
): MiddlewareHandler {
	const onError = (c: Context) => c.json(errorBody('bad_request', 'Body too large'), 413);
	const fallback = bodyLimit({ maxSize: DEFAULT_BODY_LIMIT, onError });
	const routes = uploads.map((u) => ({
		method: u.method.toUpperCase(),
		match: pathMatcher(u.path),
		limit: bodyLimit({ maxSize: u.maxBytes, onError }),
	}));
	return (c, next) => {
		const route = routes.find((r) => r.method === c.req.method && r.match.test(c.req.path));
		return (route?.limit ?? fallback)(c, next);
	};
}
