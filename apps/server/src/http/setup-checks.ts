import type { BackupService } from '@famos/adapters/backup';
import type { AiSettingsService } from '@famos/adapters/llm-aisdk';
import type { TelegramTables } from '@famos/adapters/telegram';
import type { WebPushTables } from '@famos/adapters/webpush';
import { CORE_CAPABILITIES, type CoreTables, type Kernel } from '@famos/core';
import { FamosError, type IdentityAdmin, personPresent } from '@famos/sdk';
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from './env.ts';
import { errorResponses } from './errors.ts';

/**
 * The facts behind Settings → Setup status that no other read gives in one place, as plain
 * answers. The page decides what each answer means for the family.
 */
export const SetupChecksSchema = z.object({
	/** `FAMOS_BASE_URL` as the admin set it; null while only the local default is in use. */
	address: z.string().nullable(),
	/** A model for reading is chosen (a fast, a vision or a smart one). */
	aiReading: z.boolean(),
	/** Off-site backup targets that are switched on. */
	backupTargets: z.number().int().nonnegative(),
	/** People who have a PIN. */
	pinMembers: z.number().int().nonnegative(),
	/** Trusted family devices (not displays) that were not removed. */
	familyDevices: z.number().int().nonnegative(),
	/** People who have a phone for notifications or a Telegram account linked. */
	phoneReach: z.number().int().nonnegative(),
});
export type SetupChecks = z.infer<typeof SetupChecksSchema>;

export interface SetupChecksDeps {
	kernel: Kernel;
	ai: Pick<AiSettingsService, 'get'>;
	backups: Pick<BackupService, 'listTargets'>;
	identity: Pick<IdentityAdmin, 'signInMethods'>;
	/** The address the admin configured for the family, when there is one. */
	publicUrl?: string | undefined;
}

type Tables = CoreTables & WebPushTables & TelegramTables;

export async function readSetupChecks(deps: SetupChecksDeps): Promise<SetupChecks> {
	const db = deps.kernel.ctx.db.withTables<Tables>();
	const [ai, targets, methods, devices, members, push, telegram] = await Promise.all([
		deps.ai.get(),
		deps.backups.listTargets(),
		deps.identity.signInMethods(),
		db
			.selectFrom('core_devices')
			.select('id')
			.where('kind', '=', 'family')
			.where('revoked_at', 'is', null)
			.execute(),
		db.selectFrom('core_members').select('id').where('archived_at', 'is', null).execute(),
		db.selectFrom('webpush_subscriptions').select('member_id').distinct().execute(),
		db.selectFrom('telegram_links').select('member_id').distinct().execute(),
	]);
	const active = new Set(members.map((m) => m.id));
	return {
		address: deps.publicUrl ?? null,
		aiReading: Boolean(ai.roles.fast ?? ai.roles.vision ?? ai.roles.smart),
		backupTargets: targets.filter((t) => t.enabled).length,
		pinMembers: [...methods].filter(([id, m]) => m.pin && active.has(id)).length,
		familyDevices: devices.length,
		phoneReach: new Set(
			[...push, ...telegram].map((r) => r.member_id).filter((id) => active.has(id)),
		).size,
	};
}

export function mountSetupChecksRoute(app: OpenAPIHono<AppEnv>, deps: SetupChecksDeps): void {
	const route = createRoute({
		method: 'get',
		path: '/api/v1/core/setup-checks',
		operationId: 'core.getSetupChecks',
		summary: 'The facts behind the setup checks: address, AI, backups, PIN devices and phones',
		tags: ['core'],
		responses: {
			200: {
				description: 'Setup facts',
				content: { 'application/json': { schema: SetupChecksSchema } },
			},
			...errorResponses,
		},
		security: [{ session: [] }],
	});
	app.openapi(route, async (c) => {
		const actor = c.get('actor');
		if (!actor || !personPresent(actor))
			throw new FamosError('unauthenticated', 'Sign in required');
		if (!deps.kernel.access.can(actor, CORE_CAPABILITIES.settingsManage.id))
			throw new FamosError('forbidden', 'Your role does not allow this', {
				reason: 'capability',
				capability: CORE_CAPABILITIES.settingsManage.id,
			});
		return c.json(await readSetupChecks(deps), 200);
	});
}
