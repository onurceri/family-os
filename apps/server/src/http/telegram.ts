import {
	LinkCodeSchema,
	MemberLinkSchema,
	type Telegram,
	TelegramStatusSchema,
	TokenInputSchema,
} from '@famos/adapters/telegram';
import { type AuditTrail, CORE_CAPABILITIES } from '@famos/core';
import { type AccessControl, assertFullSignIn } from '@famos/sdk';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';
import { body, json, requireCapability, requirePerson } from './route-kit.ts';

/**
 * Telegram settings for admins and linking for members. The bot token and the link code are
 * credentials, so like passwords and provider keys these routes call the adapter directly instead
 * of going through actions; setting the token and making a link code record themselves in the
 * audit log. Ending a link is an action (`core.unlinkTelegram`). The token is never returned.
 */
const base = { tags: ['telegram'], security: [{ session: [] }] };

export function mountTelegramRoutes(
	app: OpenAPIHono<AppEnv>,
	telegram: Telegram,
	access: AccessControl,
	audit: AuditTrail,
): void {
	const requireAdmin = (c: Context<AppEnv>) =>
		requireCapability(
			c,
			access,
			CORE_CAPABILITIES.settingsManage.id,
			'Not allowed to manage Telegram',
		);
	const me = (c: Context<AppEnv>): string => requirePerson(c).memberId;

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
		const actor = requireAdmin(c);
		await telegram.setToken(c.req.valid('json').token);
		// Never the token: the row says only that the bot was connected or disconnected.
		await audit.record(actor, 'telegram.setToken');
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
		const memberId = me(c);
		const code = await telegram.createLinkCode(memberId);
		if (actor) await audit.record(actor, 'telegram.createLinkCode', memberId);
		return c.json(code, 200);
	});
}
