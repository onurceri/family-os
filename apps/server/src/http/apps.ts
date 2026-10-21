import {
	APP_TOKEN_MAX_DAYS,
	APP_TOKEN_WARN_DAYS,
	AppSchema,
	AppTokenSchema,
	type Kernel,
	presentApp,
	presentAppToken,
} from '@famos/core';
import { FamosError, personPresent } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';

/**
 * Connected apps (Home Assistant, scripts): an admin registers one with a role, a mode and the
 * members it may act for (`core.createApp` and the other `core.*App` actions), and gives it keys
 * here. A key's secret is shown once and an action's answer is kept for replays, so minting one
 * is a route that calls the service directly and records itself in the audit log; the service
 * allows only an admin who signed in with a password.
 */
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const base = { tags: ['apps'], security: [{ session: [] }] };

const ListSchema = z.object({
	apps: z.array(AppSchema),
	/** Days before a key's expiry that the page starts to warn. */
	warnDays: z.number().int(),
});
const Name = z.string().trim().min(1).max(60);
const Days = z.number().int().min(1).max(APP_TOKEN_MAX_DAYS);
const TokenCreateSchema = z.object({
	name: Name,
	/** Days until the key stops working; none by default (a key lasts until revoked). */
	expiresInDays: Days.optional(),
});
const TokenCreatedSchema = z.object({
	/** The key itself. Shown once; only its hash is kept. */
	secret: z.string(),
	token: AppTokenSchema,
});
const AppParams = z.object({ appId: z.string() });

export function mountAppRoutes(app: OpenAPIHono<AppEnv>, kernel: Kernel): void {
	const me = (c: Context<AppEnv>) => {
		const actor = c.get('actor');
		if (!actor || !personPresent(actor))
			throw new FamosError('unauthenticated', 'Sign in required');
		return actor;
	};

	const list = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/apps',
		operationId: 'apps.list',
		summary: 'Connected apps with their keys (never the secrets); needs permission to manage apps',
		responses: { 200: { description: 'Apps', ...json(ListSchema) }, ...errorResponses },
	});
	app.openapi(list, async (c) => {
		const apps = await kernel.apps.list(me(c));
		return c.json({ apps: apps.map(presentApp), warnDays: APP_TOKEN_WARN_DAYS }, 200);
	});

	const createToken = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/apps/{appId}/tokens',
		operationId: 'apps.createToken',
		summary: 'Add a key to an app (to rotate: add one, switch the app over, revoke the old one)',
		request: {
			params: AppParams,
			body: { content: { 'application/json': { schema: TokenCreateSchema } }, required: true },
		},
		responses: { 201: { description: 'Created', ...json(TokenCreatedSchema) }, ...errorResponses },
	});
	app.openapi(createToken, async (c) => {
		const actor = me(c);
		const created = await kernel.apps.createToken(
			actor,
			c.req.valid('param').appId,
			c.req.valid('json'),
		);
		await kernel.audit.record(actor, 'apps.createToken', created.token.id);
		return c.json({ secret: created.secret, token: presentAppToken(created.token) }, 201);
	});
}
