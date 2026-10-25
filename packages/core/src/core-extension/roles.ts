import { BUILT_IN_ROLES, defineAction, defineRoute, FamosError, idSchema } from '@famos/sdk';
import { z } from 'zod';
import { CORE_CAPABILITIES } from '../core-capabilities.ts';
import { roleChanged } from '../core-events.ts';
import type { CoreExtensionDeps } from './deps.ts';
import { members } from './member-rows.ts';

export const RoleViewSchema = z.object({
	id: z.string(),
	/** Null for built-in roles: the UI shows their translated name. */
	name: z.string().nullable(),
	builtIn: z.boolean(),
	base: z.enum(['admin', 'member', 'supervised', 'guest']),
	overrides: z.record(z.string(), z.boolean()),
	/** Effective capability ids. */
	capabilities: z.array(z.string()),
	/** Active members with this role. */
	members: z.number().int(),
});

export const CapabilityViewSchema = z.object({
	id: z.string(),
	/** i18n key, e.g. `calendar:cap_edit`. */
	label: z.string(),
	level: z.enum(['view', 'use', 'edit', 'manage']),
	critical: z.boolean(),
	/** The extension (or `core`) that declared it. */
	owner: z.string(),
});

/** Custom roles and what each role can do. */
export function createRoles(deps: CoreExtensionDeps) {
	/** Overrides may only name registered, non-critical capabilities. */
	const checkOverrides = (overrides: Record<string, boolean>) => {
		const access = deps.access();
		for (const id of Object.keys(overrides)) {
			const capability = access.capability(id);
			if (!capability) throw new FamosError('bad_request', `Unknown capability "${id}"`);
			if (capability.critical)
				throw new FamosError('bad_request', `"${id}" belongs to the Admin role only`);
		}
	};

	const RoleInputSchema = z.object({
		name: z.string().trim().min(1).max(40),
		base: z.enum(['member', 'supervised', 'guest']),
		overrides: z.record(z.string(), z.boolean()).default({}),
	});

	const createRole = defineAction({
		id: 'core.createRole',
		title: 'Create a role from a built-in one',
		input: RoleInputSchema,
		output: z.object({ id: z.string() }),
		requires: CORE_CAPABILITIES.rolesManage.id,
		approval: 'never',
		async run(uow, input) {
			checkOverrides(input.overrides);
			const now = uow.clock.now();
			const id = uow.ids.next('role');
			await members(uow.db)
				.insertInto('core_roles')
				.values({
					id,
					name: input.name,
					base: input.base,
					overrides: JSON.stringify(input.overrides),
					created_at: now,
					updated_at: now,
				})
				.execute();
			uow.emit(roleChanged, { roleId: id });
			return { id };
		},
	});

	const updateRole = defineAction({
		id: 'core.updateRole',
		title: 'Rename a custom role or change its capabilities',
		input: z.object({
			id: idSchema('role'),
			name: RoleInputSchema.shape.name.optional(),
			overrides: z.record(z.string(), z.boolean()).optional(),
		}),
		output: z.object({ ok: z.literal(true) }),
		requires: CORE_CAPABILITIES.rolesManage.id,
		approval: 'never',
		async run(uow, input) {
			const row = await members(uow.db)
				.selectFrom('core_roles')
				.select('id')
				.where('id', '=', input.id)
				.executeTakeFirst();
			if (!row) throw new FamosError('not_found', 'Role not found');
			if (input.overrides) checkOverrides(input.overrides);
			await members(uow.db)
				.updateTable('core_roles')
				.set({
					...(input.name !== undefined && { name: input.name }),
					...(input.overrides !== undefined && { overrides: JSON.stringify(input.overrides) }),
					updated_at: uow.clock.now(),
				})
				.where('id', '=', input.id)
				.execute();
			uow.emit(roleChanged, { roleId: input.id });
			return { ok: true as const };
		},
	});

	const deleteRole = defineAction({
		id: 'core.deleteRole',
		title: 'Delete a custom role nobody has',
		input: z.object({ id: idSchema('role') }),
		output: z.object({ ok: z.literal(true) }),
		requires: CORE_CAPABILITIES.rolesManage.id,
		approval: 'never',
		async run(uow, { id }) {
			const used = await members(uow.db)
				.selectFrom('core_members')
				.select('id')
				.where('role_id', '=', id)
				.executeTakeFirst();
			if (used)
				throw new FamosError('conflict', 'Members still have this role (archived members too)');
			const app = await members(uow.db)
				.selectFrom('core_apps')
				.select('id')
				.where('role_id', '=', id)
				.where('revoked_at', 'is', null)
				.executeTakeFirst();
			if (app) throw new FamosError('conflict', 'A connected app still has this role');
			await members(uow.db).deleteFrom('core_roles').where('id', '=', id).execute();
			uow.emit(roleChanged, { roleId: id });
			return { ok: true as const };
		},
	});

	const listRoles = defineRoute({
		method: 'get',
		path: '/roles',
		operationId: 'core.listRoles',
		summary: 'Capabilities and roles, with what each role can do',
		requires: CORE_CAPABILITIES.membersView.id,
		response: z.object({
			capabilities: z.array(CapabilityViewSchema),
			roles: z.array(RoleViewSchema),
		}),
		async handle(ctx, { actor }) {
			// A display may see who lives here (with "show names"), not how roles are set up.
			if (actor.kind === 'display')
				throw new FamosError('forbidden', 'A display only shows', { reason: 'display' });
			const access = deps.access();
			const counts = await members(ctx.db)
				.selectFrom('core_members')
				.select(['role_id', (eb) => eb.fn.countAll<number>().as('n')])
				.where('archived_at', 'is', null)
				.groupBy('role_id')
				.execute();
			const count = (id: string) => Number(counts.find((c) => c.role_id === id)?.n ?? 0);
			const builtIn = BUILT_IN_ROLES.map((id) => ({
				id,
				name: null,
				builtIn: true,
				base: id,
				overrides: {},
				capabilities: [...access.effective(id)],
				members: count(id),
			}));
			const custom = access.customRoles().map((r) => ({
				id: r.id,
				name: r.name,
				builtIn: false,
				base: r.base,
				overrides: r.overrides,
				capabilities: [...access.effective(r.id)],
				members: count(r.id),
			}));
			return {
				capabilities: access.capabilities.map((c) => ({
					id: c.id,
					label: c.label,
					level: c.level,
					critical: c.critical === true,
					owner: c.id.split('.')[0] as string,
				})),
				roles: [...builtIn, ...custom],
			};
		},
	});

	return { createRole, updateRole, deleteRole, listRoles };
}
