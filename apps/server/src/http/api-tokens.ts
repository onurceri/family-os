import {
	API_TOKEN_DEFAULT_DAYS,
	API_TOKEN_MAX_DAYS,
	ApiTokenSchema,
	CORE_CAPABILITIES,
	type Kernel,
	presentApiToken,
} from '@famos/core';
import { FamosError, personPresent } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';

/**
 * Personal API tokens for AI apps. A token's secret is shown once and an action's answer is kept
 * for replays, so creating one is a route that calls the service directly and records itself in
 * the audit log. Revoking a token and the MCP switch are actions (`core.revokeApiToken`,
 * `core.setMcpEnabled`). A member manages their own tokens; an admin can list and revoke
 * everyone's.
 */
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const base = { tags: ['mcp'], security: [{ session: [] }] };

const CreateInputSchema = z.object({
	name: z.string().trim().min(1).max(60),
	scope: z.enum(['read', 'read_write']),
	/** Days until it stops working; default 90, at most 365. */
	expiresInDays: z.number().int().min(1).max(API_TOKEN_MAX_DAYS).default(API_TOKEN_DEFAULT_DAYS),
});
const CreatedSchema = z.object({
	/** The token itself. Shown once; only its hash is kept. */
	secret: z.string(),
	token: ApiTokenSchema,
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
	const list = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/mcp/tokens',
		operationId: 'mcp.listTokens',
		summary: 'My API tokens (never the secrets); admins can list everyone’s with all=true',
		request: { query: z.object({ all: z.enum(['true', 'false']).optional() }) },
		responses: {
			200: { description: 'Tokens', ...json(z.object({ tokens: z.array(ApiTokenSchema) })) },
			...errorResponses,
		},
	});
	app.openapi(list, async (c) => {
		const all = c.req.valid('query').all === 'true';
		const tokens = await kernel.apiTokens.list(me(c), { all });
		const names = all ? await members() : null;
		return c.json({ tokens: tokens.map((t) => presentApiToken(t, names)) }, 200);
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
		const actor = me(c);
		const created = await kernel.apiTokens.create(actor, c.req.valid('json'));
		await kernel.audit.record(actor, 'mcp.createToken', created.token.id);
		return c.json({ secret: created.secret, token: presentApiToken(created.token, null) }, 201);
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
}
