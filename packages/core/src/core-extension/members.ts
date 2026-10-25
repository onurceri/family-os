import { defineAction, defineRoute, FamosError } from '@famos/sdk';
import { z } from 'zod';
import { revokeTokensOf } from '../api-tokens.ts';
import { CORE_CAPABILITIES } from '../core-capabilities.ts';
import { memberChanged } from '../core-events.ts';
import type { createLanguages } from '../languages.ts';
import type { CoreExtensionDeps } from './deps.ts';
import {
	AboutSchema,
	activeAdminCount,
	ColorSchema,
	END_CREDENTIALS_JOB,
	findMember,
	insertMember,
	LocaleSchema,
	MemberIdSchema,
	MemberSchema,
	members,
	NO_SIGN_IN,
	RoleIdSchema,
	requireMember,
	SignInMethodsSchema,
	toMember,
} from './member-rows.ts';

/** Adding, changing and archiving family members, and who lives here. */
export function createMembers(
	deps: CoreExtensionDeps,
	languages: ReturnType<typeof createLanguages>,
) {
	/** A role id is a built-in role or an existing custom role. */
	const assertRole = (roleId: string) => {
		const access = deps.access();
		if (!access.isBuiltIn(roleId) && !access.customRoles().some((r) => r.id === roleId)) {
			throw new FamosError('bad_request', `Unknown role "${roleId}"`);
		}
	};

	const createMember = defineAction({
		id: 'core.createMember',
		title: 'Add a family member',
		input: z.object({
			displayName: z.string().trim().min(1).max(60),
			roleId: RoleIdSchema,
			about: AboutSchema.optional(),
			color: ColorSchema.optional(),
			locale: LocaleSchema.optional(),
		}),
		output: MemberSchema,
		requires: CORE_CAPABILITIES.membersManage.id,
		approval: 'never',
		async run(uow, input) {
			assertRole(input.roleId);
			if (input.locale) languages.assertKnown(input.locale);
			const row = await insertMember(uow, input);
			uow.emit(memberChanged, { memberId: row.id });
			return toMember(row);
		},
	});

	const updateMember = defineAction({
		id: 'core.updateMember',
		title: 'Update a family member',
		input: z.object({
			memberId: MemberIdSchema,
			displayName: z.string().trim().min(1).max(60).optional(),
			roleId: RoleIdSchema.optional(),
			about: AboutSchema.nullable().optional(),
			color: ColorSchema.optional(),
			locale: LocaleSchema.nullable().optional(),
		}),
		output: MemberSchema,
		requires: CORE_CAPABILITIES.membersManage.id,
		approval: 'never',
		async run(uow, input) {
			if (input.roleId !== undefined) assertRole(input.roleId);
			if (input.locale) languages.assertKnown(input.locale);
			const current = await findMember(uow.db, input.memberId);
			if (
				current.role_id === 'admin' &&
				input.roleId !== undefined &&
				input.roleId !== 'admin' &&
				(await activeAdminCount(uow.db)) <= 1
			) {
				throw new FamosError('conflict', 'The last admin cannot be demoted', {
					reason: 'last_admin',
				});
			}
			await members(uow.db)
				.updateTable('core_members')
				.set({
					...(input.displayName !== undefined && { display_name: input.displayName }),
					...(input.roleId !== undefined && { role_id: input.roleId }),
					...(input.about !== undefined && { about: input.about?.trim() || null }),
					...(input.color !== undefined && { color: input.color }),
					...(input.locale !== undefined && { locale: input.locale }),
					updated_at: uow.clock.now(),
				})
				.where('id', '=', input.memberId)
				.execute();
			uow.emit(memberChanged, { memberId: input.memberId });
			return toMember(await findMember(uow.db, input.memberId));
		},
	});

	const setMyLanguage = defineAction({
		id: 'core.setMyLanguage',
		title: 'Choose my own language',
		input: z.object({ locale: LocaleSchema.nullable() }),
		output: MemberSchema,
		// Everyone may choose how the app speaks to them; it changes nothing for anyone else.
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		approval: 'never',
		async run(uow, input) {
			const actor = requireMember(uow.actor);
			if (input.locale) languages.assertKnown(input.locale);
			await members(uow.db)
				.updateTable('core_members')
				.set({ locale: input.locale, updated_at: uow.clock.now() })
				.where('id', '=', actor.memberId)
				.execute();
			uow.emit(memberChanged, { memberId: actor.memberId });
			return toMember(await findMember(uow.db, actor.memberId));
		},
	});

	const archiveMember = defineAction({
		id: 'core.archiveMember',
		title: 'Remove a family member from the family',
		input: z.object({ memberId: MemberIdSchema }),
		output: MemberSchema,
		requires: CORE_CAPABILITIES.membersManage.id,
		approval: 'never',
		async run(uow, input) {
			const current = await findMember(uow.db, input.memberId);
			if (
				current.role_id === 'admin' &&
				current.archived_at === null &&
				(await activeAdminCount(uow.db)) <= 1
			) {
				throw new FamosError('conflict', 'The last admin cannot be archived', {
					reason: 'last_admin',
				});
			}
			const now = uow.clock.now();
			await members(uow.db)
				.updateTable('core_members')
				.set({ archived_at: now, updated_at: now })
				.where('id', '=', input.memberId)
				.execute();
			// Keys and addresses end in this transaction, or not at all.
			await revokeTokensOf(uow.db, input.memberId, now);
			await uow.enqueue(END_CREDENTIALS_JOB, { memberId: input.memberId });
			uow.emit(memberChanged, { memberId: input.memberId, endSessions: true });
			return toMember(await findMember(uow.db, input.memberId));
		},
	});

	const listMembers = defineRoute({
		method: 'get',
		path: '/members',
		operationId: 'core.listMembers',
		summary: 'Active family members',
		requires: CORE_CAPABILITIES.membersView.id,
		// How each person signs in: only for those who manage people.
		response: z.array(MemberSchema.extend({ signIn: SignInMethodsSchema.optional() })),
		async handle(ctx, { actor }) {
			const rows = await members(ctx.db)
				.selectFrom('core_members')
				.selectAll()
				.where('archived_at', 'is', null)
				.orderBy('created_at')
				.execute();
			// A display sees names and colors only: no role and no private notes.
			if (actor.kind === 'display')
				return rows.map((row) => ({ ...toMember(row), roleId: '', about: null }));
			if (!deps.access().can(actor, CORE_CAPABILITIES.membersManage.id)) return rows.map(toMember);
			const methods = await deps.identity.signInMethods();
			return rows.map((row) => ({ ...toMember(row), signIn: methods.get(row.id) ?? NO_SIGN_IN }));
		},
	});

	const listProfiles = defineRoute({
		method: 'get',
		path: '/profiles',
		operationId: 'core.listProfiles',
		summary: 'Profile picker for PIN sign-in (name and color only)',
		// Only trusted family devices (or signed-in members) see who lives here.
		requires: 'trusted-device',
		response: z.array(z.object({ id: z.string(), displayName: z.string(), color: z.string() })),
		async handle(ctx) {
			const rows = await members(ctx.db)
				.selectFrom('core_members')
				.select(['id', 'display_name', 'color', 'role_id'])
				.where('archived_at', 'is', null)
				.orderBy('created_at')
				.execute();
			// Only people who have a PIN, and whose role lets them use it, appear in the picker.
			const access = deps.access();
			const methods = await deps.identity.signInMethods();
			return rows
				.filter(
					(r) =>
						methods.get(r.id)?.pin === true &&
						access.effective(r.role_id).has(CORE_CAPABILITIES.signInPin.id),
				)
				.map((r) => ({ id: r.id, displayName: r.display_name, color: r.color }));
		},
	});

	return { createMember, updateMember, setMyLanguage, archiveMember, listMembers, listProfiles };
}
