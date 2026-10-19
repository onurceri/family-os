import {
	DeviceListSchema,
	PublicKeySchema,
	SubscribeInputSchema,
	TestResultSchema,
	UnsubscribeInputSchema,
	type WebPush,
} from '@famos/adapters/webpush';
import type { CoreTables, Kernel } from '@famos/core';
import { FamosError, personPresent } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';

/**
 * Web Push devices of the signed-in member. Subscriptions are credentials, so like
 * passwords and device trust these routes call the adapter directly instead of going through
 * actions. Every route is for the member's own devices only.
 */
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const body = <S extends z.ZodType>(schema: S) => ({
	body: { content: { 'application/json': { schema } }, required: true as const },
});
const base = { tags: ['push'], security: [{ session: [] }] };
const Ok = z.object({ ok: z.literal(true) });

export function mountPushRoutes(app: OpenAPIHono<AppEnv>, push: WebPush, kernel: Kernel): void {
	const translate = kernel.translate;
	const me = (c: Context<AppEnv>): string => {
		const actor = c.get('actor');
		if (!actor || !personPresent(actor))
			throw new FamosError('unauthenticated', 'Sign in required');
		return actor.memberId;
	};

	const getKey = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/push/key',
		operationId: 'push.getKey',
		summary: 'The public key a browser subscribes with',
		responses: { 200: { description: 'Public key', ...json(PublicKeySchema) }, ...errorResponses },
	});
	app.openapi(getKey, async (c) => {
		me(c);
		return c.json({ publicKey: await push.publicKey() }, 200);
	});

	const subscribe = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/push/subscriptions',
		operationId: 'push.subscribe',
		summary: 'Register this browser to receive notifications',
		request: body(SubscribeInputSchema),
		responses: { 201: { description: 'Registered', ...json(Ok) }, ...errorResponses },
	});
	app.openapi(subscribe, async (c) => {
		const memberId = me(c);
		await push.subscribe(memberId, c.req.valid('json'));
		return c.json({ ok: true as const }, 201);
	});

	const unsubscribe = createRoute({
		...base,
		method: 'delete',
		path: '/api/v1/push/subscriptions',
		operationId: 'push.unsubscribe',
		summary: 'Stop notifications on this browser',
		request: body(UnsubscribeInputSchema),
		responses: { 200: { description: 'Removed', ...json(Ok) }, ...errorResponses },
	});
	app.openapi(unsubscribe, async (c) => {
		await push.unsubscribe(me(c), c.req.valid('json').endpoint);
		return c.json({ ok: true as const }, 200);
	});

	const list = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/push/subscriptions',
		operationId: 'push.listDevices',
		summary: 'My devices that receive notifications (no endpoints)',
		responses: { 200: { description: 'Devices', ...json(DeviceListSchema) }, ...errorResponses },
	});
	app.openapi(list, async (c) => c.json(await push.list(me(c)), 200));

	const test = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/push/test',
		operationId: 'push.sendTest',
		summary: 'Send a test notification to my devices now',
		responses: {
			200: { description: 'Devices reached', ...json(TestResultSchema) },
			...errorResponses,
		},
	});
	app.openapi(test, async (c) => {
		const memberId = me(c);
		const row = await kernel.ctx.db
			.withTables<CoreTables>()
			.selectFrom('core_members')
			.select('locale')
			.where('id', '=', memberId)
			.executeTakeFirst();
		const locale = row?.locale ?? (await kernel.ctx.family.settings()).locale;
		// An explicit test from the person: sent directly, not through the queue.
		const sent = await push.sendTest(memberId, {
			title: translate(locale, 'push_test_title'),
			body: translate(locale, 'push_test_body'),
		});
		return c.json({ sent }, 200);
	});
}
