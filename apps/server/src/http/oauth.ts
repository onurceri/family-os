import type { Kernel } from '@famos/core';
import { FamosError, personPresent } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';
import { failureRedirect } from './oauth-endpoints.ts';

/**
 * What a person does about an AI app signing in, and the setting up of an app that cannot
 * register itself. Deciding gives the app a one-time code and creating an app shows its secret
 * once, so both are routes that call the service directly; the service records them in the audit
 * log in the same transaction. Everything else about these apps is an action. Only a person at a
 * password sign-in may decide: the service refuses a display, an app and a PIN session.
 */
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const base = { tags: ['oauth'], security: [{ session: [] }] };

/** Where Home Assistant's own cloud relay brings a person back after signing in. */
const HOME_ASSISTANT_REDIRECT = 'https://my.home-assistant.io/redirect/oauth';
const HOME_ASSISTANT_NAME = 'Home Assistant';

const ScopeSchema = z.enum(['read', 'read_write']);

const RequestSchema = z.object({
	id: z.string(),
	client: z.object({
		name: z.string(),
		kind: z.enum(['registered', 'dynamic', 'metadata']),
		/** When the app was set up or registered. */
		createdAt: z.number(),
		/** The host the app is identified by, when it is identified by an address. */
		clientHost: z.string().nullable(),
	}),
	/** Where the person goes back to after deciding. Always shown. */
	redirectHost: z.string(),
	/** The app runs on this device. */
	loopback: z.boolean(),
	/** The most the person may give: what the app asked for. */
	scope: ScopeSchema,
	expiresAt: z.number(),
});
const DecisionInputSchema = z.object({
	/** What to give; never more than the app asked for. */
	scope: ScopeSchema.optional(),
});
const RedirectSchema = z.object({
	/** Where to send the browser next: the app's return address with the answer on it. */
	redirectUrl: z.string(),
});
const ClientSchema = z.object({
	id: z.string(),
	/** What the app sends as its client id. */
	clientId: z.string(),
	kind: z.enum(['registered', 'dynamic', 'metadata']),
	name: z.string(),
	redirectUris: z.array(z.string()),
	requirePkce: z.boolean(),
	createdAt: z.number(),
});
const CreateClientInputSchema = z.object({
	/** `ha` sets up Home Assistant: its name, its return addresses, and no PKCE (it cannot do it). */
	preset: z.enum(['ha']).optional(),
	name: z.string().trim().min(1).max(60).optional(),
	redirectUris: z.array(z.string().max(2000)).max(5).optional(),
	/** With the `ha` preset: the address Home Assistant is reached at on the home network. */
	homeAssistantUrl: z.string().max(2000).optional(),
});
const CreatedClientSchema = z.object({
	client: ClientSchema,
	/** The app's secret. Shown once; only its hash is kept. */
	clientSecret: z.string(),
	/** What to give the app as the address of FamilyOS's AI door; null while the family address is not usable. */
	mcpUrl: z.string().nullable(),
});

export function mountOAuthRoutes(app: OpenAPIHono<AppEnv>, kernel: Kernel): void {
	const oauth = kernel.oauth;
	const me = (c: Context<AppEnv>) => {
		const actor = c.get('actor');
		if (!actor || !personPresent(actor))
			throw new FamosError('unauthenticated', 'Sign in required');
		return actor;
	};
	/** Signing in AI apps is off (or MCP is): these routes are not there, as `/mcp` is not. */
	const active = async () => {
		const status = await oauth.status();
		if (!status.active || !status.issuer) throw new FamosError('not_found', 'Not found');
		return { ...status, issuer: status.issuer };
	};

	const getRequest = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/oauth/requests/{id}',
		operationId: 'oauth.getRequest',
		summary: 'What an AI app asks for while it waits for your decision',
		request: { params: z.object({ id: z.string().min(1).max(100) }) },
		responses: { 200: { description: 'The request', ...json(RequestSchema) }, ...errorResponses },
	});
	app.openapi(getRequest, async (c) => {
		const actor = me(c);
		await active();
		return c.json(await oauth.getRequest(actor, c.req.valid('param').id), 200);
	});

	const approve = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/oauth/requests/{id}/approve',
		operationId: 'oauth.approveRequest',
		summary: 'Let the AI app in, with what it asked for or less',
		request: {
			params: z.object({ id: z.string().min(1).max(100) }),
			body: { content: { 'application/json': { schema: DecisionInputSchema } }, required: true },
		},
		responses: {
			200: { description: 'Where to go next', ...json(RedirectSchema) },
			...errorResponses,
		},
	});
	app.openapi(approve, async (c) => {
		const actor = me(c);
		const status = await active();
		const { scope } = c.req.valid('json');
		const given = await oauth.approve(actor, c.req.valid('param').id, scope ? { scope } : {});
		const url = new URL(given.redirectUri);
		url.searchParams.set('code', given.code);
		if (given.state !== null) url.searchParams.set('state', given.state);
		url.searchParams.set('iss', status.issuer);
		return c.json({ redirectUrl: url.toString() }, 200);
	});

	const deny = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/oauth/requests/{id}/deny',
		operationId: 'oauth.denyRequest',
		summary: 'Turn the AI app away',
		request: { params: z.object({ id: z.string().min(1).max(100) }) },
		responses: {
			200: { description: 'Where to go next', ...json(RedirectSchema) },
			...errorResponses,
		},
	});
	app.openapi(deny, async (c) => {
		const actor = me(c);
		const status = await active();
		const denied = await oauth.deny(actor, c.req.valid('param').id);
		return c.json(
			{
				redirectUrl: failureRedirect(
					denied.redirectUri,
					status.issuer,
					'access_denied',
					denied.state,
				),
			},
			200,
		);
	});

	const createClient = createRoute({
		...base,
		tags: ['mcp'],
		method: 'post',
		path: '/api/v1/mcp/oauth-clients',
		operationId: 'mcp.createOAuthClient',
		summary: 'Set up an AI app that cannot register itself; its secret is shown once',
		request: {
			body: {
				content: { 'application/json': { schema: CreateClientInputSchema } },
				required: true,
			},
		},
		responses: { 201: { description: 'Created', ...json(CreatedClientSchema) }, ...errorResponses },
	});
	app.openapi(createClient, async (c) => {
		const actor = me(c);
		const input = c.req.valid('json');
		let name: string;
		let redirectUris: string[];
		if (input.preset === 'ha') {
			if (input.redirectUris)
				throw new FamosError('bad_request', 'Home Assistant needs no return addresses');
			name = input.name ?? HOME_ASSISTANT_NAME;
			redirectUris = [HOME_ASSISTANT_REDIRECT];
			if (input.homeAssistantUrl) redirectUris.push(homeAssistantCallback(input.homeAssistantUrl));
		} else {
			if (input.homeAssistantUrl)
				throw new FamosError('bad_request', 'The Home Assistant address belongs to its preset');
			if (!input.name || !input.redirectUris?.length)
				throw new FamosError('bad_request', 'An app needs a name and a return address');
			name = input.name;
			redirectUris = input.redirectUris;
		}
		// Only Home Assistant's own client may skip PKCE; it cannot send one.
		const created = await oauth.createClient(actor, {
			name,
			redirectUris,
			requirePkce: input.preset !== 'ha',
		});
		const { client } = created;
		return c.json(
			{
				client: {
					id: client.id,
					clientId: client.clientId,
					kind: client.kind,
					name: client.name,
					redirectUris: client.redirectUris,
					requirePkce: client.requirePkce,
					createdAt: client.createdAt,
				},
				clientSecret: created.clientSecret,
				mcpUrl: (await oauth.status()).resource,
			},
			201,
		);
	});
}

/** Where Home Assistant takes a person back to when it is reached directly on the home network. */
function homeAssistantCallback(address: string): string {
	let url: URL;
	try {
		url = new URL(address);
	} catch {
		throw new FamosError('bad_request', 'The Home Assistant address is not a web address');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		throw new FamosError('bad_request', 'The Home Assistant address is not a web address');
	return `${url.origin}${url.pathname.replace(/\/+$/, '')}/auth/external/callback`;
}
