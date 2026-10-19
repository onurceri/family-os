import {
	API_TOKEN_DEFAULT_DAYS,
	API_TOKEN_MAX_DAYS,
	type ApiTokenView,
	CORE_CAPABILITIES,
	type Kernel,
} from '@famos/core';
import { FamosError, personPresent } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';

/**
 * Personal API tokens for AI apps. A token is a credential, so like push
 * subscriptions and device trust these routes call the service directly instead of going
 * through actions. A member manages their own tokens; an admin can list and revoke everyone's.
 */
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const base = { tags: ['mcp'], security: [{ session: [] }] };

const TokenSchema = z.object({
	id: z.string(),
	name: z.string(),
	scope: z.enum(['read', 'read_write']),
	expiresAt: z.number().int().nullable(),
	lastUsedAt: z.number().int().nullable(),
	createdAt: z.number().int(),
	revokedAt: z.number().int().nullable(),
	/** Whose token it is (the list of everyone's only; null for the caller's own). */
	member: z.string().nullable(),
});
const CreateInputSchema = z.object({
	name: z.string().trim().min(1).max(60),
	scope: z.enum(['read', 'read_write']),
	/** Days until it stops working; default 90, at most 365. */
	expiresInDays: z.number().int().min(1).max(API_TOKEN_MAX_DAYS).default(API_TOKEN_DEFAULT_DAYS),
});
const CreatedSchema = z.object({
	/** The token itself. Shown once; only its hash is kept. */
	secret: z.string(),
	token: TokenSchema,
});
const McpSettingsSchema = z.object({
	/** Whether the MCP endpoint answers at all. */
	enabled: z.boolean(),
	/** Whether the caller may create tokens. */
	canCreateTokens: z.boolean(),
});

export function mountApiTokenRoutes(app: OpenAPIHono<AppEnv>, kernel: Kernel): void {
	const members = async () =>
		new Map((await kernel.ctx.family.members()).map((m) => [m.id as string, m.displayName]));
	const me = (c: Context<AppEnv>) => {
		const actor = c.get('actor');
		if (!actor || !personPresent(actor))
			throw new FamosError('unauthenticated', 'Sign in required');
		return actor;
	};
	const present = (token: ApiTokenView, names: Map<string, string> | null) => ({
		id: token.id,
		name: token.name,
		scope: token.scope,
		expiresAt: token.expiresAt,
		lastUsedAt: token.lastUsedAt,
		createdAt: token.createdAt,
		revokedAt: token.revokedAt,
		member: names ? (names.get(token.memberId) ?? null) : null,
	});

	const list = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/mcp/tokens',
		operationId: 'mcp.listTokens',
		summary: 'My API tokens (never the secrets); admins can list everyone’s with all=true',
		request: { query: z.object({ all: z.enum(['true', 'false']).optional() }) },
		responses: {
			200: { description: 'Tokens', ...json(z.object({ tokens: z.array(TokenSchema) })) },
			...errorResponses,
		},
	});
	app.openapi(list, async (c) => {
		const all = c.req.valid('query').all === 'true';
		const tokens = await kernel.apiTokens.list(me(c), { all });
		const names = all ? await members() : null;
		return c.json({ tokens: tokens.map((t) => present(t, names)) }, 200);
	});

	const create = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/mcp/tokens',
		operationId: 'mcp.createToken',
		summary: 'Create an API token for an AI app; the secret is shown once',
		request: {
			body: { content: { 'application/json': { schema: CreateInputSchema } }, required: true },
		},
		responses: { 201: { description: 'Created', ...json(CreatedSchema) }, ...errorResponses },
	});
	app.openapi(create, async (c) => {
		const created = await kernel.apiTokens.create(me(c), c.req.valid('json'));
		return c.json({ secret: created.secret, token: present(created.token, null) }, 201);
	});

	const revoke = createRoute({
		...base,
		method: 'delete',
		path: '/api/v1/mcp/tokens/{tokenId}',
		operationId: 'mcp.revokeToken',
		summary: 'Revoke an API token at once',
		request: { params: z.object({ tokenId: z.string() }) },
		responses: { 200: { description: 'Revoked', ...json(TokenSchema) }, ...errorResponses },
	});
	app.openapi(revoke, async (c) => {
		const token = await kernel.apiTokens.revoke(me(c), c.req.valid('param').tokenId);
		return c.json(present(token, null), 200);
	});

	const settings = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/mcp/settings',
		operationId: 'mcp.getSettings',
		summary: 'Whether the MCP endpoint is on, and whether I may create tokens',
		responses: { 200: { description: 'Settings', ...json(McpSettingsSchema) }, ...errorResponses },
	});
	app.openapi(settings, async (c) => {
		const actor = me(c);
		return c.json(
			{
				enabled: await kernel.apiTokens.isEnabled(),
				canCreateTokens: kernel.access.can(actor, CORE_CAPABILITIES.mcpUse.id),
			},
			200,
		);
	});

	const setSettings = createRoute({
		...base,
		method: 'put',
		path: '/api/v1/mcp/settings',
		operationId: 'mcp.setEnabled',
		summary: 'Turn the MCP endpoint on or off (needs permission to manage AI)',
		request: {
			body: {
				content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } },
				required: true,
			},
		},
		responses: {
			200: { description: 'Saved', ...json(z.object({ enabled: z.boolean() })) },
			...errorResponses,
		},
	});
	app.openapi(setSettings, async (c) => {
		const { enabled } = c.req.valid('json');
		await kernel.apiTokens.setEnabled(me(c), enabled);
		return c.json({ enabled }, 200);
	});
}
