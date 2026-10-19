import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
	createBackup,
	KEEP_BEFORE_UPDATE,
	pruneBackups,
	readBackupManifest,
	restoreBackup,
} from '../src/backup.ts';
import { openDatabase } from '../src/connection.ts';

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), 'famos-test-'));
	const dbPath = join(dir, 'famos.db');
	const filesDir = join(dir, 'files');
	await mkdir(join(filesDir, 'inbox'), { recursive: true });
	await writeFile(join(filesDir, 'inbox', 'flyer.txt'), 'school trip');
	const handle = openDatabase({ path: dbPath });
	await sql`create table notes (id integer primary key, body text)`.execute(handle.db);
	await sql`insert into notes (body) values ('original')`.execute(handle.db);
	return { dir, dbPath, filesDir, handle };
}

describe('backup', () => {
	it('round-trips database and files, keeping the replaced data aside', async () => {
		const { dir, dbPath, filesDir, handle } = await setup();
		const backupsDir = join(dir, 'backups');
		const { path, manifest } = await createBackup({
			sqlite: handle.sqlite,
			filesDir,
			backupsDir,
			appVersion: '0.0.0-test',
			schema: { core: ['0001_init'] },
			reason: 'manual',
		});
		expect(manifest.db.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect((await readBackupManifest(path)).schema).toEqual({ core: ['0001_init'] });

		// Diverge after the backup, then restore.
		await sql`update notes set body = 'changed'`.execute(handle.db);
		await writeFile(join(filesDir, 'inbox', 'flyer.txt'), 'changed');
		await handle.close();

		await restoreBackup({ file: path, dbPath, filesDir });

		const reopened = openDatabase({ path: dbPath });
		const rows = await sql<{ body: string }>`select body from notes`.execute(reopened.db);
		expect(rows.rows).toEqual([{ body: 'original' }]);
		expect(await readFile(join(filesDir, 'inbox', 'flyer.txt'), 'utf8')).toBe('school trip');
		await reopened.close();
	});

	it('prunes old backups of the same reason only', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'famos-prune-'));
		for (const n of [
			'famos-1-scheduled.tar',
			'famos-2-scheduled.tar',
			'famos-3-scheduled.tar',
			'famos-1-manual.tar',
		]) {
			await writeFile(join(dir, n), '');
		}
		const deleted = await pruneBackups(dir, 'scheduled', 2);
		expect(deleted.map((p) => p.split('/').at(-1))).toEqual(['famos-1-scheduled.tar']);
	});

	it('keeps the copies made before a change to the data apart from the nightly ones', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'famos-prune-'));
		const nightly = [1, 2, 3, 4, 5].map((n) => `famos-0${n}-scheduled.tar`);
		const before = [6, 7, 8, 9, 10].map(
			(n) => `famos-${String(n).padStart(2, '0')}-pre-migration.tar`,
		);
		for (const n of [...nightly, ...before]) await writeFile(join(dir, n), '');
		const deleted = await pruneBackups(dir, 'pre-migration', KEEP_BEFORE_UPDATE);
		expect(deleted.map((p) => p.split('/').at(-1)).sort()).toEqual(before.slice(0, 2));
		const left = await readdir(dir);
		for (const n of nightly) expect(left).toContain(n);
	});
});
