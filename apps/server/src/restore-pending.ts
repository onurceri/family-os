import { clearRestoreMarker, openDatabase, readRestoreMarker } from '@famos/db';
import type { Runtime } from './runtime.ts';

/**
 * The first start after `famos restore`: everyone signs in again, and what the family ended after
 * the backup (keys, devices, members, passwords, calendar addresses, Telegram links) stays ended,
 * read from the database the restore moved aside. The restore left a marker; it is removed only
 * when this succeeded, so a start that failed halfway runs the step again (it is idempotent). A failure
 * stops the start: nothing serves with the restored sessions alive.
 */
export async function finishRestore(runtime: Runtime): Promise<void> {
	const { config, kernel, logger, telegram } = runtime;
	const marker = await readRestoreMarker(config.dbPath);
	if (!marker) return;
	const aside = marker.previousPath
		? openDatabase({ path: marker.previousPath, readonly: true })
		: null;
	// A server that had no data yet leaves an empty database behind (opening it creates one):
	// there is nothing in it to carry.
	const previous =
		aside?.sqlite.prepare("select 1 from sqlite_master where name = 'core_members'").get() != null
			? aside
			: null;
	try {
		const report = await kernel.reconcileRestore(
			previous?.db ?? null,
			previous ? [() => telegram.carryUnlinks(previous.db)] : [],
		);
		await clearRestoreMarker(config.dbPath);
		logger.info(
			{ restoredAt: marker.restoredAt, kept: report.kept, failed: report.failed },
			'restore reconciled: everyone signs in again',
		);
	} catch (error) {
		// Not served: the restored sessions, keys and devices would be live, including those the
		// family ended after the backup. The marker stays, so the next start runs the step again.
		logger.error({ err: error }, 'carrying over after a restore failed; the server does not start');
		throw new Error(
			`The restore could not be finished, so the server did not start (nobody could be signed out safely). Start it again; the step runs again. Cause: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	} finally {
		await aside?.close();
	}
}
