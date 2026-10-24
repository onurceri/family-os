import {
	type Email,
	EmailSaveResultSchema,
	EmailSenderSchema,
	EmailSettingsInputSchema,
	EmailSettingsSchema,
} from '@famos/adapters/email';
import { CORE_CAPABILITIES, type Kernel } from '@famos/core';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';
import { body, json, requireCapability, requireSignedIn } from './route-kit.ts';

/**
 * Email settings for admins: what to read, and saving the mailbox. The mailbox password is a
 * credential, and saving tests it first (the saved `enabled` follows the test), so like the
 * Telegram token and provider keys that route calls the adapter directly and records itself in the
 * audit log. Disconnecting, the allowed senders and checking now are actions
 * (`core.disconnectEmail` ...). The password is never returned.
 */
const base = { tags: ['email'], security: [{ session: [] }] };

export function mountEmailRoutes(app: OpenAPIHono<AppEnv>, email: Email, kernel: Kernel): void {
	const requireAdmin = (c: Context<AppEnv>) =>
		requireCapability(
			c,
			kernel.access,
			CORE_CAPABILITIES.settingsManage.id,
			'Not allowed to manage email',
		);

	const getSettings = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/email/settings',
		operationId: 'email.getSettings',
		summary: 'The mailbox the family reads mail from and the state of the last check (no password)',
		responses: {
			200: { description: 'Email settings', ...json(EmailSettingsSchema) },
			...errorResponses,
		},
	});
	app.openapi(getSettings, async (c) => {
		requireAdmin(c);
		return c.json(await email.settings(), 200);
	});

	// For every member: Quick add says whether mail can be forwarded to the family, nothing more.
	const getAvailability = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/email/available',
		operationId: 'email.getAvailability',
		summary: 'Whether the family mailbox is set up and switched on (no address, no settings)',
		responses: {
			200: {
				description: 'Whether mail reaches Quick add',
				...json(z.object({ available: z.boolean() })),
			},
			...errorResponses,
		},
	});
	app.openapi(getAvailability, async (c) => {
		requireSignedIn(c);
		const s = await email.settings();
		return c.json({ available: s.configured && s.enabled }, 200);
	});

	const putSettings = createRoute({
		...base,
		method: 'put',
		path: '/api/v1/email/settings',
		operationId: 'email.updateSettings',
		summary:
			'Save the mailbox and test it (log in, open the mailbox, create the processed folder). The password is stored encrypted and never returned',
		request: body(EmailSettingsInputSchema),
		responses: {
			200: { description: 'Saved, with the test result', ...json(EmailSaveResultSchema) },
			...errorResponses,
		},
	});
	app.openapi(putSettings, async (c) => {
		const actor = requireAdmin(c);
		const saved = await email.update(c.req.valid('json'));
		// The saved switch depends on a test that needs the password and the network, so this
		// stays a route; the row never holds what was typed.
		await kernel.audit.record(actor, 'email.updateSettings');
		return c.json(saved, 200);
	});

	const listSenders = createRoute({
		...base,
		method: 'get',
		path: '/api/v1/email/senders',
		operationId: 'email.listSenders',
		summary: 'Addresses whose mail may reach the Inbox, and whose Inbox it becomes',
		responses: {
			200: { description: 'Allowed senders', ...json(z.array(EmailSenderSchema)) },
			...errorResponses,
		},
	});
	app.openapi(listSenders, async (c) => {
		requireAdmin(c);
		return c.json(await email.senders(), 200);
	});
}
