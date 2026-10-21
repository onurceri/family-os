import {
	type Email,
	EmailSaveResultSchema,
	EmailSenderInputSchema,
	EmailSenderSchema,
	EmailSettingsInputSchema,
	EmailSettingsSchema,
} from '@famos/adapters/email';
import { CORE_CAPABILITIES, type Kernel } from '@famos/core';
import { FamosError } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';

/**
 * Email settings for admins. The mailbox password is a credential, so like the
 * Telegram token and provider keys these routes call the adapter directly instead of going
 * through actions. The password is never returned.
 */
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });
const body = <S extends z.ZodType>(schema: S) => ({
	body: { content: { 'application/json': { schema } }, required: true as const },
});
const base = { tags: ['email'], security: [{ session: [] }] };
const Ok = z.object({ ok: z.literal(true) });

export function mountEmailRoutes(app: OpenAPIHono<AppEnv>, email: Email, kernel: Kernel): void {
	const requireAdmin = (c: Context<AppEnv>) => {
		const actor = c.get('actor');
		if (!actor) throw new FamosError('unauthenticated', 'Sign in required');
		if (!kernel.access.can(actor, CORE_CAPABILITIES.settingsManage.id))
			throw new FamosError('forbidden', 'Not allowed to manage email');
		return actor;
	};

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
		if (!c.get('actor')) throw new FamosError('unauthenticated', 'Sign in required');
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

	const deleteSettings = createRoute({
		...base,
		method: 'delete',
		path: '/api/v1/email/settings',
		operationId: 'email.disconnect',
		summary: 'Forget the mailbox and its password (the allowed senders stay)',
		responses: { 200: { description: 'Disconnected', ...json(Ok) }, ...errorResponses },
	});
	app.openapi(deleteSettings, async (c) => {
		requireAdmin(c);
		await email.remove();
		return c.json({ ok: true as const }, 200);
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

	const addSender = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/email/senders',
		operationId: 'email.addSender',
		summary: 'Allow an address to send to the Inbox (replaces the entry of the same address)',
		request: body(EmailSenderInputSchema),
		responses: {
			200: { description: 'The allowed sender', ...json(EmailSenderSchema) },
			...errorResponses,
		},
	});
	app.openapi(addSender, async (c) => {
		requireAdmin(c);
		const input = c.req.valid('json');
		if (!(await kernel.memberActor(input.memberId)))
			throw new FamosError('bad_request', 'Choose a member of the family');
		return c.json(await email.addSender(input), 200);
	});

	const removeSender = createRoute({
		...base,
		method: 'delete',
		path: '/api/v1/email/senders/{address}',
		operationId: 'email.removeSender',
		summary: 'Stop accepting mail from an address',
		request: { params: z.object({ address: z.string().min(1).max(320) }) },
		responses: { 200: { description: 'Removed', ...json(Ok) }, ...errorResponses },
	});
	app.openapi(removeSender, async (c) => {
		requireAdmin(c);
		await email.removeSender(c.req.valid('param').address);
		return c.json({ ok: true as const }, 200);
	});

	const check = createRoute({
		...base,
		method: 'post',
		path: '/api/v1/email/check',
		operationId: 'email.checkNow',
		summary: 'Check the mailbox now (the worker does it in the background)',
		responses: { 202: { description: 'Queued', ...json(Ok) }, ...errorResponses },
	});
	app.openapi(check, async (c) => {
		requireAdmin(c);
		await email.checkNow();
		return c.json({ ok: true as const }, 202);
	});
}
