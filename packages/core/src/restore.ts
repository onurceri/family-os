import {
	BUILT_IN_ROLES,
	type BuiltInRole,
	type CapabilityDefinition,
	type Clock,
	type DbExecutor,
	type ExtensionDefinition,
	type IdentityAdmin,
	type JobContext,
	type Logger,
	type NotifyRequest,
} from '@famos/sdk';
import { roleGrants } from './access.ts';
import { pauseAllApps } from './apps.ts';
import type { CoreTables } from './tables.ts';

/** What a restore changed on the first start after it. */
export interface RestoreReport {
	/** Everyone signed in again: all sessions were ended. */
	sessionsEnded: true;
	/** Keys, devices, members, passwords and links decided after the backup that stayed decided. */
	kept: number;
	/** The extensions whose `onRestore` failed; the others were reconciled. */
	failed: string[];
	/** Connected apps paused until an admin looks at them again. */
	appsPaused: number;
	/** Access that was narrowed after the backup and stayed narrow. */
	access: {
		/** People whose role is the narrower one, or who hold a role that was narrowed. */
		people: string[];
		/** Custom roles whose capabilities were narrowed back to what they are now. */
		roles: string[];
		/** People whose two roles could not be combined into one that exists: they keep today's. */
		undecided: string[];
	};
}

export interface RestoreDeps {
	db: DbExecutor;
	clock: Clock;
	logger: Logger;
	/** Every registered capability, to compare what two roles grant. */
	capabilities: readonly CapabilityDefinition[];
	/** Reloads the cached custom roles after the step changed them. */
	refreshRoles: () => Promise<void>;
	identity: IdentityAdmin;
	extensions: () => readonly ExtensionDefinition[];
	/** An extension's context with its own tables only; `readonly` for the database set aside. */
	jobContextFor: (id: string) => JobContext;
	previousViewFor: (id: string, previous: DbExecutor) => DbExecutor;
	/** Revokes a member's keys and enqueues the end of their extensions' credentials. */
	endCredentialsOf: (memberId: string) => Promise<void>;
	notify: (request: NotifyRequest) => Promise<void>;
}

/** Counts a step for the note the admins get, or notes that it could not be read. */
type Step = () => Promise<number>;

/**
 * The step run once on the first start after a backup was restored. A restore puts the old
 * database back as it was, which would also bring back what the family ended since: sessions,
 * a password changed after a leak, revoked keys and devices, archived members. Everyone signs
 * in again, and what the database set aside (`previous`, null on a new server) shows as ended
 * or changed later stays ended or changed. Only things that end access are carried, never ones
 * that grant it, and a row `previous` does not have is left as restored. Idempotent.
 */
export async function reconcileRestore(
	deps: RestoreDeps,
	previous: DbExecutor | null,
	hostSteps: readonly Step[] = [],
): Promise<RestoreReport> {
	await deps.identity.endAllSessions();
	let kept = 0;
	const failed: string[] = [];
	let access: RestoreReport['access'] = { people: [], roles: [], undecided: [] };
	// A restore may bring back keys of apps that were revoked, rotated or leaked since: every
	// live app waits until an admin has looked at it.
	const appsPaused = await pauseAllApps(deps.db, deps.clock.now());
	if (previous) {
		const now = deps.clock.now();
		const archived = await carryArchivedMembers(deps.db, previous);
		for (const memberId of archived) {
			// Their keys and extension credentials end as they would have, and their logins go.
			await deps.endCredentialsOf(memberId);
			await deps.identity.revokeAll(memberId);
		}
		kept += archived.length;
		access = await carryNarrowerAccess(deps, previous, now);
		kept += access.people.length + access.roles.length;
		if (access.roles.length > 0) await deps.refreshRoles();
		if (access.people.length > 0 || access.roles.length > 0 || access.undecided.length > 0)
			deps.logger.info(
				{ people: access.people, roles: access.roles, undecided: access.undecided },
				'restore kept the narrower access of people and roles',
			);
		kept += (await carryRevoked(deps.db, previous, 'core_api_tokens', now)).length;
		kept += (await carryRevoked(deps.db, previous, 'core_devices', now)).length;
		kept += (await carryRevoked(deps.db, previous, 'core_apps', now)).length;
		kept += (await carryRevoked(deps.db, previous, 'core_app_tokens', now)).length;
		kept += await deps.identity.carryNewerLogins(previous);
		for (const step of hostSteps) kept += await step();
	}
	for (const ext of deps.extensions()) {
		if (!ext.onRestore) continue;
		try {
			const carried = await ext.onRestore({
				...deps.jobContextFor(ext.id),
				previous: previous ? deps.previousViewFor(ext.id, previous) : null,
			});
			kept += carried;
		} catch (error) {
			// One extension's failure must not leave the rest of the family's data unreconciled.
			deps.logger.error({ err: error, extension: ext.id }, 'carrying over after a restore failed');
			failed.push(ext.id);
		}
	}
	await deps.notify({
		kind: 'core.backupRestored',
		to: { capability: 'core.settings.manage' },
		title: { key: 'app:notify_backup_restored_title' },
		body:
			kept > 0
				? { key: 'app:notify_backup_restored_body', params: { kept } }
				: { key: 'app:notify_backup_restored_body_none' },
		url: '/settings/backups',
		source: { kind: 'restore', id: 'restore' },
	});
	if (access.people.length > 0)
		await deps.notify({
			kind: 'core.backupRestored',
			to: { capability: 'core.settings.manage' },
			title: { key: 'app:notify_backup_restored_access_title' },
			body: {
				key: 'app:notify_backup_restored_access_body',
				params: { count: access.people.length },
			},
			url: '/settings/members',
			source: { kind: 'restore', id: 'restore-access' },
		});
	if (appsPaused > 0)
		await deps.notify({
			kind: 'core.backupRestored',
			to: { capability: 'core.apps.manage' },
			title: { key: 'app:notify_backup_restored_apps_title' },
			body: { key: 'app:notify_backup_restored_apps_body', params: { count: appsPaused } },
			url: '/settings/connected-apps',
			source: { kind: 'restore', id: 'restore-apps' },
		});
	return { sessionsEnded: true, kept, failed, appsPaused, access };
}

/** Members archived since the backup are archived again; returns their ids. */
async function carryArchivedMembers(db: DbExecutor, previous: DbExecutor): Promise<string[]> {
	const later = await previous
		.withTables<CoreTables>()
		.selectFrom('core_members')
		.select(['id', 'archived_at'])
		.where('archived_at', 'is not', null)
		.execute();
	const now = db.withTables<CoreTables>();
	const carried: string[] = [];
	for (const member of later) {
		const result = await now
			.updateTable('core_members')
			.set({ archived_at: member.archived_at, updated_at: member.archived_at as number })
			.where('id', '=', member.id)
			.where('archived_at', 'is', null)
			.executeTakeFirst();
		if (Number(result.numUpdatedRows) > 0) carried.push(member.id);
	}
	return carried;
}

/** Keys or devices revoked since the backup are revoked again; returns their ids. */
async function carryRevoked(
	db: DbExecutor,
	previous: DbExecutor,
	table: 'core_api_tokens' | 'core_devices' | 'core_apps' | 'core_app_tokens',
	now: number,
): Promise<string[]> {
	const later = await previous
		.withTables<CoreTables>()
		.selectFrom(table)
		.select(['id', 'revoked_at'])
		.where('revoked_at', 'is not', null)
		.execute();
	const tables = db.withTables<CoreTables>();
	const carried: string[] = [];
	for (const row of later) {
		const result = await tables
			.updateTable(table)
			.set({ revoked_at: row.revoked_at ?? now })
			.where('id', '=', row.id)
			.where('revoked_at', 'is', null)
			.executeTakeFirst();
		if (Number(result.numUpdatedRows) > 0) carried.push(row.id);
	}
	if (table === 'core_api_tokens' && carried.length > 0)
		await tables.deleteFrom('core_api_token_handles').where('token_id', 'in', carried).execute();
	return carried;
}

type CustomGrants = { base: 'member' | 'supervised' | 'guest'; overrides: Record<string, boolean> };

const BUILT_IN_IDS: readonly BuiltInRole[] = BUILT_IN_ROLES;

const isSubset = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
	[...a].every((id) => b.has(id));
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
	a.size === b.size && isSubset(a, b);

/**
 * For every custom role and every person, the narrower of the backup's and the earlier
 * database's access stays: a role keeps only the capabilities both gave it, and a person keeps
 * the role that grants less (judged by capabilities, never by names). A promotion or widening
 * made after the backup is lost, as the restore loses the rest of that day. Two roles that
 * each grant something the other does not become the built-in or custom role granting exactly
 * what both give, when there is one; otherwise the person keeps the role they have now.
 */
async function carryNarrowerAccess(
	deps: RestoreDeps,
	previous: DbExecutor,
	now: number,
): Promise<RestoreReport['access']> {
	const result: RestoreReport['access'] = { people: [], roles: [], undecided: [] };
	const before = previous.withTables<CoreTables>();
	const tables = deps.db.withTables<CoreTables>();
	const parse = (r: { base: CustomGrants['base']; overrides: string }): CustomGrants => ({
		base: r.base,
		overrides: JSON.parse(r.overrides) as Record<string, boolean>,
	});
	const earlierRows = await before.selectFrom('core_roles').selectAll().execute();
	const earlier = new Map(earlierRows.map((r) => [r.id, parse(r)]));
	const current = new Map(
		(await tables.selectFrom('core_roles').selectAll().execute()).map((r) => [r.id, parse(r)]),
	);
	const grantsOf = (roles: Map<string, CustomGrants>, id: string): Set<string> | null => {
		if ((BUILT_IN_IDS as readonly string[]).includes(id))
			return roleGrants(deps.capabilities, id as BuiltInRole);
		const role = roles.get(id);
		return role ? roleGrants(deps.capabilities, role) : null;
	};

	for (const [id, wasRole] of earlier) {
		const role = current.get(id);
		if (!role) continue;
		const had = roleGrants(deps.capabilities, role);
		const both = new Set(
			[...roleGrants(deps.capabilities, wasRole)].filter((capability) => had.has(capability)),
		);
		if (sameSet(both, had)) continue;
		// Spelled out for every capability, so the role cannot gain one a later extension adds.
		const overrides = Object.fromEntries(
			deps.capabilities.filter((c) => !c.critical).map((c) => [c.id, both.has(c.id)]),
		);
		await tables
			.updateTable('core_roles')
			.set({ overrides: JSON.stringify(overrides), updated_at: now })
			.where('id', '=', id)
			.execute();
		current.set(id, { base: role.base, overrides });
		result.roles.push(id);
	}

	/** A role the earlier database had but the backup lacks comes along when a person needs it. */
	const bringRole = async (id: string) => {
		if (current.has(id)) return;
		const row = earlierRows.find((r) => r.id === id);
		if (!row) return;
		await tables.insertInto('core_roles').values(row).execute();
		current.set(id, parse(row));
	};

	const people = new Set<string>();
	const members = await tables.selectFrom('core_members').select(['id', 'role_id']).execute();
	const laterMembers = new Map(
		(await before.selectFrom('core_members').select(['id', 'role_id']).execute()).map((m) => [
			m.id,
			m.role_id,
		]),
	);
	for (const member of members) {
		const laterRole = laterMembers.get(member.id);
		if (laterRole === undefined) continue;
		if (laterRole === member.role_id) {
			// Same role id: a role narrowed above already changed what this person holds.
			if (result.roles.includes(laterRole)) people.add(member.id);
			continue;
		}
		const wanted = grantsOf(earlier, laterRole);
		const restored = grantsOf(current, member.role_id);
		if (!wanted || !restored) continue;
		if (sameSet(wanted, restored)) continue;
		let target: string;
		if (isSubset(wanted, restored)) target = laterRole;
		else if (isSubset(restored, wanted)) continue;
		else {
			// Each grants something the other does not.
			const both = new Set([...wanted].filter((capability) => restored.has(capability)));
			const fitting = [...BUILT_IN_IDS, ...current.keys()].find((id) => {
				const grants = grantsOf(current, id);
				return grants !== null && sameSet(grants, both);
			});
			if (fitting) target = fitting;
			else {
				target = laterRole;
				result.undecided.push(member.id);
			}
		}
		if (target === member.role_id) continue;
		await bringRole(target);
		await tables
			.updateTable('core_members')
			.set({ role_id: target, updated_at: now })
			.where('id', '=', member.id)
			.execute();
		people.add(member.id);
	}
	result.people = [...people];
	return result;
}
