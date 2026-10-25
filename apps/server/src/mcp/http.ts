import type { AiSettingsService } from '@famos/adapters/llm-aisdk';
import { type AuthenticatedToken, type Kernel, OAUTH_SCOPES } from '@famos/core';
import type { Logger } from '@famos/sdk';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import { authenticateBearer } from '../http/authenticate.ts';
import type { AppEnv } from '../http/env.ts';
import { PROGRAM_BODY_MAX_BYTES } from '../http/limits.ts';
import { createRateLimiter, type RateLimiter } from '../http/rate-limit.ts';
import { createServerFor } from './server.ts';

/** Requests per token per minute. */
export const MCP_RATE_PER_MINUTE = 60;
/** Wrong or missing tokens per client address per minute. */
const MAX_BAD_TOKENS_PER_MINUTE = 30;

/** JSON-RPC error codes the endpoint answers itself (before any MCP method runs). */
const UNAUTHORIZED = -32001;
const FORBIDDEN = -32003;
const RATE_LIMITED = -32029;

const rpcError = (code: number, message: string) => ({
	jsonrpc: '2.0' as const,
	error: { code, message },
	id: null,
});

/** Query parameters that look like a token: refused, so tokens do not end up in logs and history. */
const TOKEN_PARAM = /token|key|auth|secret|password|bearer/i;

/**
 * The MCP endpoint: `/mcp`, stateless (spec 2026-07-28; the older 2025 handshake is
 * served by the SDK's stateless fallback), authenticated by a bearer token in the `Authorization`
 * header only: a personal API key, or an access token an AI app got by signing in. Cookies are
 * never read here, so this is not a CSRF target: a browser cannot attach the token on its own.
 */
export function mountMcp(
	app: OpenAPIHono<AppEnv>,
	deps: {
		kernel: Kernel;
		ai: AiSettingsService;
		appVersion: string;
		logger: Logger;
		clientIp: (c: Context) => string;
		/** Wrong tokens per address; shared with the other bearer door when given. */
		badTokens?: RateLimiter;
	},
): void {
	const { kernel, logger } = deps;
	const tokens = kernel.apiTokens;
	const perToken = createRateLimiter({ max: MCP_RATE_PER_MINUTE, windowMs: 60_000 });
	const badTokens =
		deps.badTokens ?? createRateLimiter({ max: MAX_BAD_TOKENS_PER_MINUTE, windowMs: 60_000 });

	const handler = createMcpHandler(
		async (ctx) => {
			const principal = ctx.authInfo?.extra?.principal;
			if (!principal) throw new Error('MCP request without a principal');
			return createServerFor(
				{ kernel, ai: deps.ai, appVersion: deps.appVersion },
				tokens,
				principal as Parameters<typeof createServerFor>[2],
			);
		},
		{
			legacy: 'stateless',
			onerror: (error) => logger.warn({ err: error.name }, 'mcp error'),
		},
	);

	// The checks run before the adapter parses the body, so refused callers cost nothing.
	const principals = new WeakMap<Request, AuthenticatedToken>();
	app.use('/mcp', async (c, next) => {
		if (!(await tokens.isEnabled())) return c.json({ error: { code: 'not_found' } }, 404);

		// An app that is not signed in is told where to sign in, when the family allows that.
		const challenge = async (tokenSent: boolean) => {
			const oauth = await kernel.oauth.status();
			return oauth.active && oauth.issuer
				? `Bearer resource_metadata="${oauth.issuer}/.well-known/oauth-protected-resource/mcp", scope="${OAUTH_SCOPES.join(' ')}"${tokenSent ? ', error="invalid_token"' : ''}`
				: `Bearer realm="FamilyOS MCP"${tokenSent ? ', error="invalid_token"' : ''}`;
		};
		const fail = async (
			status: 401 | 403 | 429,
			code: number,
			message: string,
			retry?: number,
			tokenSent = false,
		) => {
			if (status === 401) c.header('www-authenticate', await challenge(tokenSent));
			if (retry) c.header('retry-after', String(retry));
			return c.json(rpcError(code, message), status);
		};
		const unauthorized = async (message: string, tokenSent = false) => {
			if (!badTokens.hit(deps.clientIp(c)))
				return fail(429, RATE_LIMITED, 'Too many failed attempts', 60);
			return fail(401, UNAUTHORIZED, message, undefined, tokenSent);
		};

		const url = new URL(c.req.url);
		for (const [name, value] of url.searchParams)
			if (TOKEN_PARAM.test(name) || value.startsWith('famos_'))
				return unauthorized(
					'Tokens in the address are refused; send an Authorization: Bearer header',
				);

		const caller = await authenticateBearer(kernel, c.req.raw.headers);
		if (caller.outcome === 'missing')
			return unauthorized('Send an Authorization: Bearer header with a FamilyOS token');
		if (caller.outcome === 'unknown')
			return unauthorized('The token is unknown, expired or revoked', true);
		if (caller.outcome === 'forbidden')
			return fail(403, FORBIDDEN, 'This person may not use API tokens');
		const principal = caller.principal;
		if (!perToken.hit(principal.token.id))
			return fail(429, RATE_LIMITED, 'Too many requests; try again in a minute', 60);
		// Only a permitted use counts as one.
		await tokens.touch(principal.token.id);
		principals.set(c.req.raw, principal);
		return next();
	});

	// The adapter parses the JSON body for the handler. Host and Origin are not restricted (the
	// endpoint is meant to be reached from other machines and the token protects it); `host` is
	// not a bind address here, so the adapter neither enforces nor warns about localhost rules.
	const mcp = createMcpHonoApp({ host: 'any', maxRequestBodySize: PROGRAM_BODY_MAX_BYTES });
	mcp.all('/', (c) => {
		const principal = principals.get(c.req.raw);
		if (!principal) return c.json(rpcError(UNAUTHORIZED, 'Not authenticated'), 401);
		return handler.fetch(c.req.raw, {
			parsedBody: c.get('parsedBody' as never),
			authInfo: {
				// Never the secret itself: only the token's id travels further.
				token: principal.token.id,
				clientId: principal.token.id,
				scopes: [principal.token.scope],
				extra: { principal },
			},
		});
	});
	app.route('/mcp', mcp as never);
}
