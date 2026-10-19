import type {
	Clock,
	DbExecutor,
	ExtensionDefinition,
	IdentityAdmin,
	JobContext,
	Logger,
	NotifyRequest,
} from '@famos/sdk';
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
}

export interface RestoreDeps {
	db: DbExecutor;
	clock: Clock;
	logger: Logger;
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
	if (appsPaused > 0)
		await deps.notify({
			kind: 'core.backupRestored',
			to: { capability: 'core.apps.manage' },
			title: { key: 'app:notify_backup_restored_apps_title' },
			body: { key: 'app:notify_backup_restored_apps_body', params: { count: appsPaused } },
			url: '/settings/connected-apps',
			source: { kind: 'restore', id: 'restore-apps' },
		});
	return { sessionsEnded: true, kept, failed, appsPaused };
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
