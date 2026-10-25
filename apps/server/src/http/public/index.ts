import type { ApiOperation } from '@famos/core';
import { type ApiContext, FamosError } from '@famos/sdk';
import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { authenticateApp } from '../authenticate.ts';
import type { AppEnv } from '../env.ts';
import { PROGRAM_BODY_MAX_BYTES } from '../limits.ts';
import { createRateLimiter } from '../rate-limit.ts';
import { createMountChange } from './actions.ts';
import { mountChangeFeed } from './change-feed.ts';
import { mountDiscovery } from './discovery.ts';
import { mountDrafts } from './drafts.ts';
import { createMountRead } from './reads.ts';
import { PUBLIC_API_BASE, type PublicApiDeps, type PublicEnv, type PublicParts } from './shared.ts';
import { badFields, errorResponse } from './wire.ts';

export { PUBLIC_API_BASE, type PublicApiDeps, type PublicEnv } from './shared.ts';

/** Requests per app per minute: a program polling a few lists every few seconds stays far below. */
export const PUBLIC_RATE_PER_MINUTE = 300;
/** Wrong or missing keys per client address per minute (shared with the MCP endpoint). */
export const MAX_BAD_KEYS_PER_MINUTE = 30;

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
			maxSize: PROGRAM_BODY_MAX_BYTES,
			onError: (c) => {
				const { body } = errorResponse(
					badFields([{ path: 'body', message: `At most ${PROGRAM_BODY_MAX_BYTES / 1024} KB` }]),
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

	const parts: PublicParts = {
		api,
		kernel,
		deps,
		contextOf,
		assertOn,
		operations,
		exposureOfAction,
	};
	const mountRead = createMountRead(parts);
	const mountChange = createMountChange(parts);
	for (const op of operations) {
		if (op.source.kind === 'route') mountRead(op, op.source.route);
		else mountChange(op, op.source.action);
	}

	mountDiscovery(parts);
	mountDrafts(parts);
	mountChangeFeed(parts);

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
