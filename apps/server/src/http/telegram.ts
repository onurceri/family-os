import {
	LinkCodeSchema,
	MemberLinkSchema,
	type Telegram,
	TelegramStatusSchema,
	TokenInputSchema,
} from '@famos/adapters/telegram';
import { CORE_CAPABILITIES } from '@famos/core';
import { type AccessControl, assertFullSignIn, FamosError } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';

/**
 * Telegram settings for admins and linking for members. The bot token and the links
 * are credentials, so like passwords and provider keys these routes call the adapter directly
 * instead of going through actions. The token is never returned.
 */
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const body = <S extends z.ZodType>(schema: S) => ({
	body: { content: { 'application/json': { schema } }, required: true as const },
});
const base = { tags: ['telegram'], security: [{ session: [] }] };
const Ok = z.object({ ok: z.literal(true) });

export function mountTelegramRoutes(
	app: OpenAPIHono<AppEnv>,
	telegram: Telegram,
	access: AccessControl,
): void {
	const requireAdmin = (c: Context<AppEnv>) => {
		const actor = c.get('actor');
		if (!actor) throw new FamosError('unauthenticated', 'Sign in required');
		if (!access.can(actor, CORE_CAPABILITIES.settingsManage.id))
			throw new FamosError('forbidden', 'Not allowed to manage Telegram');
	};
	const me = (c: Context<AppEnv>): string => {
		const actor = c.get('actor');
		if (actor?.kind !== 'member') throw new FamosError('unauthenticated', 'Sign in required');
		return actor.memberId;
	};

	const getSettings = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/telegram/settings',
		operationId: 'telegram.getSettings',
		summary: 'Whether a bot is connected, its name and the state of the connection (no token)',
		responses: {
			200: { description: 'Telegram settings', ...json(TelegramStatusSchema) },
			...errorResponses,
		},
	});
	app.openapi(getSettings, async (c) => {
		requireAdmin(c);
		return c.json(await telegram.status(), 200);
	});

	const setToken = createRoute({
		...base,
		method: 'put',
		path: '/api/v1/telegram/token',
		operationId: 'telegram.setToken',
		summary: 'Connect a bot with its token (stored encrypted, never returned), or disconnect it',
		request: body(TokenInputSchema),
		responses: {
			200: { description: 'Telegram settings', ...json(TelegramStatusSchema) },
			...errorResponses,
		},
	});
	app.openapi(setToken, async (c) => {
		requireAdmin(c);
		await telegram.setToken(c.req.valid('json').token);
		return c.json(await telegram.status(), 200);
	});

	const getLink = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/telegram/link',
		operationId: 'telegram.getLink',
		summary: 'Whether Telegram is available and whether my account is linked',
		responses: {
			200: { description: 'My Telegram link', ...json(MemberLinkSchema) },
			...errorResponses,
		},
	});
	app.openapi(getLink, async (c) => c.json(await telegram.linkOf(me(c)), 200));

	const createLink = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/telegram/link',
		operationId: 'telegram.createLinkCode',
		summary: 'A one-time code (10 minutes) that links my Telegram account when sent to the bot',
		responses: {
			200: { description: 'The code and a t.me link', ...json(LinkCodeSchema) },
			...errorResponses,
		},
	});
	app.openapi(createLink, async (c) => {
		// A linked Telegram account acts for the member from anywhere: a PIN must not link one.
		const actor = c.get('actor');
		if (actor) assertFullSignIn(actor);
		return c.json(await telegram.createLinkCode(me(c)), 200);
	});

	const unlink = createRoute({
		...base,
		method: 'delete',
		path: '/api/v1/telegram/link',
		operationId: 'telegram.unlink',
		summary: 'Unlink my Telegram account',
		responses: { 200: { description: 'Unlinked', ...json(Ok) }, ...errorResponses },
	});
	app.openapi(unlink, async (c) => {
		await telegram.unlink(me(c));
		return c.json({ ok: true as const }, 200);
	});
}
