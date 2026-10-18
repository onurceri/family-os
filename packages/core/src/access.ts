import {
	type AccessControl,
	type Actor,
	type AiAreaAccess,
	BUILT_IN_ROLES,
	type BuiltInRole,
	type CapabilityDefinition,
	type DbExecutor,
	defaultGrant,
} from '@famos/sdk';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { ownerOf } from './features.ts';
import type { CoreTables } from './tables.ts';

export type CustomRole = {
	id: string;
	name: string;
	base: Exclude<BuiltInRole, 'admin'>;
	overrides: Record<string, boolean>;
};

export interface Access extends AccessControl {
	/** Every registered capability, in registration order (core first). */
	readonly capabilities: readonly CapabilityDefinition[];
	capability(id: string): CapabilityDefinition | undefined;
	/** Effective capability ids of a role; empty for an unknown role. */
	effective(roleId: string): ReadonlySet<string>;
	isBuiltIn(roleId: string): roleId is BuiltInRole;
	customRoles(): readonly CustomRole[];
	/** Reloads custom roles (after a role changes). */
	refresh(db: DbExecutor): Promise<void>;
	/** Forgets cached grants (after an extension is turned on or off). */
	invalidate(): void;
}

const BUILT_IN: ReadonlySet<string> = new Set(BUILT_IN_ROLES);

/** The system actor's source for unauthenticated requests on public routes: holds no capability. */
export const ANONYMOUS = 'anonymous';

/**
 * Capability checks over the registry and the custom roles. Custom roles are cached
 * in memory (one process, refreshed when a role changes), so `can` is synchronous.
 */
export function createAccess(
	capabilities: readonly CapabilityDefinition[],
	/** Whether an extension is turned on; capabilities of turned-off extensions are inactive. */
	isOn: (extensionId: string) => boolean = () => true,
	/** The AI's access to an extension's area; `off` removes it from AI actors. */
	aiAccess: (extensionId: string) => AiAreaAccess = () => 'any',
): Access {
	const byId = new Map(capabilities.map((c) => [c.id, c]));
	let custom = new Map<string, CustomRole>();
	const cache = new Map<string, ReadonlySet<string>>();

	function effective(roleId: string): ReadonlySet<string> {
		const cached = cache.get(roleId);
		if (cached) return cached;
		const active = capabilities.filter((c) => isOn(ownerOf(c.id)));
		let granted: Set<string>;
		if (BUILT_IN.has(roleId)) {
			granted = new Set(
				active.filter((c) => defaultGrant(c, roleId as BuiltInRole)).map((c) => c.id),
			);
		} else {
			const role = custom.get(roleId);
			granted = new Set();
			if (role) {
				for (const c of active) {
					// Critical capabilities stay with the Admin role whatever a custom role says.
					const value = c.critical ? false : (role.overrides[c.id] ?? defaultGrant(c, role.base));
					if (value) granted.add(c.id);
				}
			}
		}
		cache.set(roleId, granted);
		return granted;
	}

	/** Whether a role holds a capability; no role (unknown, or none given) holds nothing. */
	const holds = (roleId: string | undefined, capability: string) =>
		roleId !== undefined && effective(roleId).has(capability);

	return {
		capabilities,
		capability: (id) => byId.get(id),
		memberCan(actor, capability) {
			if (actor.kind !== 'ai' || actor.onBehalfOf === undefined) return true;
			const definition = byId.get(capability);
			if (!definition) throw new Error(`Unknown capability "${capability}"`);
			return isOn(ownerOf(capability)) && holds(actor.roleId, capability);
		},
		effective,
		isBuiltIn: (roleId): roleId is BuiltInRole => BUILT_IN.has(roleId),
		customRoles: () => [...custom.values()],
		can(actor: Actor, capability: string): boolean {
			const definition = byId.get(capability);
			if (!definition) throw new Error(`Unknown capability "${capability}"`);
			if (!isOn(ownerOf(capability))) return false;
			// Background work may do everything; an unauthenticated request (public routes) nothing.
			if (actor.kind === 'system') return actor.source !== ANONYMOUS;
			// AI only reads; its changes are always drafts. An area that is off for the AI
			// is closed to it entirely, and a local-only one is open only to an actor whose model is
			// local (the adapter checks the same again where the model is called).
			// Acting for a member (the assistant), it also needs what that member holds: it never
			// exceeds the person asking.
			if (actor.kind === 'ai') {
				const area = aiAccess(ownerOf(capability));
				if (definition.level !== 'view' || area === 'off') return false;
				// A local-only area's data may reach only a model on the family's own network.
				if (area === 'local' && actor.local !== true) return false;
				return actor.onBehalfOf === undefined || holds(actor.roleId, capability);
			}
			// A display holds only what was granted at pairing, and never above `view`.
			if (actor.kind === 'display') {
				if (definition.level !== 'view') return false;
				if (capability === CORE_CAPABILITIES.membersView.id) return actor.showNames;
				return actor.capabilities.includes(capability);
			}
			// A PIN sign-in never administers, whatever the role (a PIN can be guessed).
			if (actor.pin === true && definition.critical === true) return false;
			return effective(actor.roleId).has(capability);
		},
		invalidate: () => cache.clear(),
		async refresh(db) {
			const rows = await db.withTables<CoreTables>().selectFrom('core_roles').selectAll().execute();
			custom = new Map(
				rows.map((r) => [
					r.id,
					{
						id: r.id,
						name: r.name,
						base: r.base,
						overrides: JSON.parse(r.overrides) as Record<string, boolean>,
					},
				]),
			);
			cache.clear();
		},
	};
}
