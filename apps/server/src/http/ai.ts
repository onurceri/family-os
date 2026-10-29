import {
	AiActivityEntrySchema,
	AiSettingsSchema,
	type AiSettingsService,
	ModelListSchema,
	ProviderKeySchema,
	ProviderSchema,
	UsageSummarySchema,
} from '@famos/adapters/llm-aisdk';
import { aiModelsChanged, CORE_CAPABILITIES, type Kernel } from '@famos/core';
import { FamosError, personPresent } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';
import { body, json, requireCapability, requireSignedIn } from './route-kit.ts';

/**
 * AI settings for admins. A provider's key is a secret, so setting it is a route that calls the
 * adapter directly and records itself in the audit log; everything else an admin chooses is an
 * action (`core.addAiProvider`, `core.setAiRoles` …). Nothing here runs a model: the connection
 * test only lists models.
 */
const ProviderParams = z.object({ providerId: z.string() });
const base = { tags: ['ai'], security: [{ session: [] }] };

export function mountAiRoutes(
	app: OpenAPIHono<AppEnv>,
	ai: AiSettingsService,
	kernel: Kernel,
): void {
	const family = kernel.ctx.family;
	const requireAdmin = (c: Context<AppEnv>) =>
		requireCapability(
			c,
			kernel.access,
			CORE_CAPABILITIES.aiManage.id,
			'Not allowed to manage AI settings',
		);
	const getSettings = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/ai/settings',
		operationId: 'ai.getSettings',
		summary: 'Providers (without keys), role → model mapping and monthly limits',
		responses: {
			200: { description: 'AI settings', ...json(AiSettingsSchema) },
			...errorResponses,
		},
	});
	app.openapi(getSettings, async (c) => {
		requireAdmin(c);
		return c.json(await ai.get(), 200);
	});

	// For every member: Quick add says before anything is typed whether the AI can read it, and
	// nothing more (no provider, model or limit).
	const getAvailability = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/ai/available',
		operationId: 'ai.getAvailability',
		summary: 'Whether AI is on and a model that reads shared things is chosen (nothing else)',
		responses: {
			200: {
				description: 'Whether the AI can read what is shared',
				...json(z.object({ reading: z.boolean() })),
			},
			...errorResponses,
		},
	});
	app.openapi(getAvailability, async (c) => {
		requireSignedIn(c);
		const { roles, switches } = await ai.get();
		return c.json(
			{ reading: switches.enabled && Boolean(roles.fast ?? roles.vision ?? roles.smart) },
			200,
		);
	});

	const setProviderKey = createRoute({
		...base,
		method: 'put',
		path: '/api/v1/ai/providers/{providerId}/key',
		operationId: 'ai.setProviderKey',
		summary: 'Store, replace or remove the provider’s API key; it is encrypted and never returned',
		request: { params: ProviderParams, ...body(ProviderKeySchema) },
		responses: {
			200: { description: 'Key saved', ...json(ProviderSchema) },
			...errorResponses,
		},
	});
	app.openapi(setProviderKey, async (c) => {
		const actor = requireAdmin(c);
		if (!personPresent(actor)) throw new FamosError('forbidden', 'Only members can do this');
		const { providerId } = c.req.valid('param');
		const provider = await ai.setApiKey(providerId, c.req.valid('json').apiKey);
		await kernel.audit.record(actor, 'ai.setProviderKey', providerId);
		// A key can make a model usable or not (family search follows the model that embeds).
		kernel.bus.emit(aiModelsChanged, {});
		return c.json(provider, 200);
	});

	const listModels = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/ai/providers/{providerId}/models',
		operationId: 'ai.listModels',
		summary: "Test the connection by listing the provider's models",
		request: { params: ProviderParams },
		responses: {
			200: { description: 'Models, or why the connection failed', ...json(ModelListSchema) },
			...errorResponses,
		},
	});
	app.openapi(listModels, async (c) => {
		requireAdmin(c);
		return c.json(await ai.listModels(c.req.valid('param').providerId), 200);
	});

	const usage = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/ai/usage',
		operationId: 'ai.getUsage',
		summary: "This month's model calls, tokens and cost, by feature and model",
		responses: {
			200: { description: 'Usage summary', ...json(UsageSummarySchema) },
			...errorResponses,
		},
	});
	app.openapi(usage, async (c) => {
		requireAdmin(c);
		return c.json(await ai.usage(), 200);
	});

	const ActivityQuery = z.object({
		limit: z.coerce.number().int().min(1).max(200).optional(),
		before: z.string().max(100).optional(),
	});
	const ActivitySchema = z.object({
		entries: z.array(
			AiActivityEntrySchema.omit({ memberId: true }).extend({
				/** Who the work was for; null for background work or someone no longer in the family. */
				member: z.string().nullable(),
			}),
		),
		/** Pass as `before` to get the next, older page; null at the end. */
		next: z.string().nullable(),
	});
	const activity = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/ai/activity',
		operationId: 'ai.getActivity',
		summary: 'Every model call, newest first: when, which feature, which areas, cost and result',
		request: { query: ActivityQuery },
		responses: {
			200: {
				description: 'A page of AI activity (no prompts or answers)',
				...json(ActivitySchema),
			},
			...errorResponses,
		},
	});
	app.openapi(activity, async (c) => {
		requireAdmin(c);
		const { limit, before } = c.req.valid('query');
		const page = await ai.activity({
			...(limit !== undefined && { limit }),
			...(before !== undefined && { before }),
		});
		const names = new Map((await family.members()).map((m) => [m.id as string, m.displayName]));
		return c.json(
			{
				entries: page.entries.map(({ memberId, ...entry }) => ({
					...entry,
					member: memberId ? (names.get(memberId) ?? null) : null,
				})),
				next: page.next,
			},
			200,
		);
	});
}
