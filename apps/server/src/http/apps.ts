import {
	APP_TOKEN_MAX_DAYS,
	APP_TOKEN_WARN_DAYS,
	type AppTokenView,
	type AppView,
	type Kernel,
} from '@famos/core';
import { APP_MODES, FamosError, personPresent } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';

/**
 * Connected apps (Home Assistant, scripts): an admin registers one with a role, a mode and the
 * members it may act for, and gives it keys. Keys are credentials, so like personal keys and
 * device trust these routes call the service directly instead of going through actions; the
 * service allows only an admin who signed in with a password.
 */
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const base = { tags: ['apps'], security: [{ session: [] }] };

const TokenSchema = z.object({
	id: z.string(),
	name: z.string(),
	expiresAt: z.number().int().nullable(),
	lastUsedAt: z.number().int().nullable(),
	createdAt: z.number().int(),
	revokedAt: z.number().int().nullable(),
});
const AppSchema = z.object({
	id: z.string(),
	name: z.string(),
	roleId: z.string(),
	mode: z.enum(APP_MODES),
	/** Member ids the app may act for. */
	actsFor: z.array(z.string()),
	createdAt: z.number().int(),
	revokedAt: z.number().int().nullable(),
	/** Set while the app is paused (by an admin, or after a restore). */
	pausedAt: z.number().int().nullable(),
	lastUsedAt: z.number().int().nullable(),
	tokens: z.array(TokenSchema),
});
const ListSchema = z.object({
	apps: z.array(AppSchema),
	/** Days before a key's expiry that the page starts to warn. */
	warnDays: z.number().int(),
});
const Name = z.string().trim().min(1).max(60);
const Days = z.number().int().min(1).max(APP_TOKEN_MAX_DAYS);
const CreateInputSchema = z.object({
	name: Name,
	roleId: z.string().min(1).max(80),
	mode: z.enum(APP_MODES),
	actsFor: z.array(z.string().max(80)).max(50).default([]),
	/** Days until the first key stops working; none by default (a key lasts until revoked). */
	expiresInDays: Days.optional(),
});
const CreatedSchema = z.object({
	/** The key itself. Shown once; only its hash is kept. */
	secret: z.string(),
	app: AppSchema,
});
const TokenCreateSchema = z.object({ name: Name, expiresInDays: Days.optional() });
const TokenCreatedSchema = z.object({ secret: z.string(), token: TokenSchema });
const UpdateInputSchema = z.object({
	name: Name.optional(),
	roleId: z.string().min(1).max(80).optional(),
	mode: z.enum(APP_MODES).optional(),
	actsFor: z.array(z.string().max(80)).max(50).optional(),
});
const AppParams = z.object({ appId: z.string() });

const presentToken = (token: AppTokenView) => ({
	id: token.id,
	name: token.name,
	expiresAt: token.expiresAt,
	lastUsedAt: token.lastUsedAt,
	createdAt: token.createdAt,
	revokedAt: token.revokedAt,
});
const presentApp = (app: AppView) => ({
	id: app.id,
	name: app.name,
	roleId: app.roleId,
	mode: app.mode,
	actsFor: app.actsFor,
	createdAt: app.createdAt,
	revokedAt: app.revokedAt,
	pausedAt: app.pausedAt,
	lastUsedAt: app.lastUsedAt,
	tokens: app.tokens.map(presentToken),
});

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

	const create = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/apps',
		operationId: 'apps.create',
		summary: 'Register a connected app with its first key; the key is shown once',
		request: {
			body: { content: { 'application/json': { schema: CreateInputSchema } }, required: true },
		},
		responses: { 201: { description: 'Created', ...json(CreatedSchema) }, ...errorResponses },
	});
	app.openapi(create, async (c) => {
		const created = await kernel.apps.create(me(c), c.req.valid('json'));
		return c.json({ secret: created.secret, app: presentApp(created.app) }, 201);
	});

	const update = createRoute({
		...base,
		method: 'patch',
		path: '/api/v1/apps/{appId}',
		operationId: 'apps.update',
		summary: 'Change an app’s name, role, mode or the members it may act for',
		request: {
			params: AppParams,
			body: { content: { 'application/json': { schema: UpdateInputSchema } }, required: true },
		},
		responses: { 200: { description: 'Saved', ...json(AppSchema) }, ...errorResponses },
	});
	app.openapi(update, async (c) => {
		const { appId } = c.req.valid('param');
		return c.json(presentApp(await kernel.apps.update(me(c), appId, c.req.valid('json'))), 200);
	});

	const pause = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/apps/{appId}/pause',
		operationId: 'apps.pause',
		summary: 'Pause an app: its keys stop working until it is resumed',
		request: { params: AppParams },
		responses: { 200: { description: 'Paused', ...json(AppSchema) }, ...errorResponses },
	});
	app.openapi(pause, async (c) =>
		c.json(presentApp(await kernel.apps.pause(me(c), c.req.valid('param').appId)), 200),
	);

	const resume = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/apps/{appId}/resume',
		operationId: 'apps.resume',
		summary: 'Let a paused app work again',
		request: { params: AppParams },
		responses: { 200: { description: 'Resumed', ...json(AppSchema) }, ...errorResponses },
	});
	app.openapi(resume, async (c) =>
		c.json(presentApp(await kernel.apps.resume(me(c), c.req.valid('param').appId)), 200),
	);

	const revoke = createRoute({
		...base,
		method: 'delete',
		path: '/api/v1/apps/{appId}',
		operationId: 'apps.revoke',
		summary: 'Revoke an app and all its keys at once',
		request: { params: AppParams },
		responses: { 200: { description: 'Revoked', ...json(AppSchema) }, ...errorResponses },
	});
	app.openapi(revoke, async (c) =>
		c.json(presentApp(await kernel.apps.revoke(me(c), c.req.valid('param').appId)), 200),
	);

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
		const created = await kernel.apps.createToken(
			me(c),
			c.req.valid('param').appId,
			c.req.valid('json'),
		);
		return c.json({ secret: created.secret, token: presentToken(created.token) }, 201);
	});

	const revokeToken = createRoute({
		...base,
		method: 'delete',
		path: '/api/v1/apps/{appId}/tokens/{tokenId}',
		operationId: 'apps.revokeToken',
		summary: 'Revoke one key of an app at once',
		request: { params: z.object({ appId: z.string(), tokenId: z.string() }) },
		responses: { 200: { description: 'Revoked', ...json(TokenSchema) }, ...errorResponses },
	});
	app.openapi(revokeToken, async (c) => {
		const { appId, tokenId } = c.req.valid('param');
		return c.json(presentToken(await kernel.apps.revokeToken(me(c), appId, tokenId)), 200);
	});
}
