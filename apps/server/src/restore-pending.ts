import { clearRestoreMarker, openDatabase, readRestoreMarker } from '@famos/db';
import type { Runtime } from './runtime.ts';

/**
 * The first start after `famos restore`: everyone signs in again, and what the family ended after
 * the backup (keys, devices, members, passwords, calendar addresses, Telegram links) stays ended,
 * read from the database the restore moved aside. The restore left a marker; it is removed only
 * when this succeeded, so a start that failed halfway runs the step again (it is idempotent).
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
		logger.error(
			{ err: error },
			'carrying over after a restore failed; it runs again at the next start',
		);
	} finally {
		await aside?.close();
	}
}
