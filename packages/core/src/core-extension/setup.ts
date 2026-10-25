import { DEFAULT_REMINDER_TIME, defineRoute, FamosError, systemActor } from '@famos/sdk';
import { formatLocaleForLanguage } from '@famos/time';
import { z } from 'zod';
import {
	FamilyNameSchema,
	FamilySettingsSchema,
	regionFormats,
	writeFamilySettings,
} from '../family.ts';
import type { createLanguages } from '../languages.ts';
import type { CoreExtensionDeps } from './deps.ts';
import { insertMember, LocaleSchema, MemberSchema, members, toMember } from './member-rows.ts';

/** Compares without an early exit, so timing does not reveal how much of a code matched. */
function sameCode(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++)
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	return diff === 0;
}

/** First-run setup: whether it is still needed, and creating the first admin. */
export function createSetup(
	deps: CoreExtensionDeps,
	languages: ReturnType<typeof createLanguages>,
) {
	const setupStatus = defineRoute({
		method: 'get',
		path: '/setup',
		operationId: 'core.getSetupStatus',
		summary: 'Whether first-run setup is still required',
		requires: 'public',
		response: z.object({
			needsSetup: z.boolean(),
			/** Setup asks for the one-time code printed in the server log. */
			needsCode: z.boolean(),
			appVersion: z.string(),
		}),
		async handle(ctx) {
			const any = await members(ctx.db)
				.selectFrom('core_members')
				.select('id')
				.limit(1)
				.executeTakeFirst();
			return {
				needsSetup: any === undefined,
				needsCode: true,
				appVersion: deps.appVersion,
			};
		},
	});

	const setup = defineRoute({
		method: 'post',
		path: '/setup',
		operationId: 'core.completeSetup',
		summary: 'Create the first admin (only while no members exist)',
		requires: 'public',
		status: 201,
		body: z.object({
			displayName: z.string().trim().min(1).max(60),
			email: z.email(),
			password: z.string().min(10).max(200),
			locale: LocaleSchema,
			timeZone: FamilySettingsSchema.shape.timeZone.optional(),
			/** Region formats, as the browser suggests them; anything left out is derived from the format locale. */
			...FamilySettingsSchema.pick({
				formatLocale: true,
				weekStart: true,
				hourCycle: true,
				temperatureUnit: true,
			}).partial().shape,
			familyName: FamilyNameSchema.optional(),
			/** The code from the server log or `data/setup-code`, so a fresh instance cannot be claimed. */
			setupCode: z.string().max(100).optional(),
		}),
		response: MemberSchema,
		async handle(ctx, { body }) {
			if (!sameCode(body.setupCode?.trim() ?? '', deps.setupCode))
				throw new FamosError('forbidden', 'The setup code is not correct');
			languages.assertKnown(body.locale);
			const row = await ctx.db.transaction().execute(async (trx) => {
				const any = await members(trx)
					.selectFrom('core_members')
					.select('id')
					.limit(1)
					.executeTakeFirst();
				if (any) throw new FamosError('conflict', 'Setup has already been completed');
				const settings = {
					...(body.familyName && { name: body.familyName }),
					timeZone: body.timeZone ?? 'UTC',
					locale: body.locale,
					...regionFormats(body.formatLocale ?? formatLocaleForLanguage(body.locale)),
					...(body.weekStart !== undefined && { weekStart: body.weekStart }),
					...(body.hourCycle && { hourCycle: body.hourCycle }),
					...(body.temperatureUnit && { temperatureUnit: body.temperatureUnit }),
					reminderTime: DEFAULT_REMINDER_TIME,
				};
				await writeFamilySettings(trx, settings, ctx.clock.now());
				return insertMember(
					{ db: trx, ids: ctx.ids, clock: ctx.clock },
					{ displayName: body.displayName, locale: body.locale, roleId: 'admin' },
				);
			});
			// Identity writes share the connection, so they run after the transaction (see IdentityAdmin).
			try {
				await deps.identity.setPasswordLogin({
					memberId: row.id,
					email: body.email,
					password: body.password,
					displayName: body.displayName,
				});
			} catch (error) {
				await members(ctx.db).deleteFrom('core_members').where('id', '=', row.id).execute();
				throw error;
			}
			// Nobody is signed in yet: the first admin and their password are made by setup itself.
			await deps.audit.record(systemActor('setup'), 'core.completeSetup', row.id);
			return toMember(row);
		},
	});

	return { setupStatus, setup };
}
