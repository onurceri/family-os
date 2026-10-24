import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import * as tar from 'tar';
import { describe, expect, it } from 'vitest';
import {
	clearRestoreMarker,
	createBackup,
	KEEP_BEFORE_UPDATE,
	pruneBackups,
	readBackupManifest,
	readRestoreMarker,
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

	it('carries installed languages, themes and extensions under their own names and restores them', async () => {
		const { dir, dbPath, filesDir, handle } = await setup();
		const dirs = {
			languagesDir: join(dir, 'languages'),
			themesDir: join(dir, 'themes'),
			extensionsDir: join(dir, 'extensions'),
		};
		for (const d of Object.values(dirs)) {
			await mkdir(join(d, 'one'), { recursive: true });
			await writeFile(join(d, 'one', 'pack.json'), `in the backup: ${d}`);
		}
		// An upload that is not installed yet is not part of the backup.
		await mkdir(join(dirs.extensionsDir, 'two', 'x.partial'), { recursive: true });
		const { path } = await createBackup({
			sqlite: handle.sqlite,
			filesDir,
			...dirs,
			backupsDir: join(dir, 'backups'),
			appVersion: '0.0.0-test',
			schema: { core: ['0001_init'] },
			reason: 'manual',
		});
		const entries: string[] = [];
		await tar.t({ file: path, onReadEntry: (e) => void entries.push(e.path) });
		expect(entries).toEqual(
			expect.arrayContaining([
				'manifest.json',
				'db/famos.db',
				'files/inbox/flyer.txt',
				'languages/one/pack.json',
				'themes/one/pack.json',
				'extensions/one/pack.json',
			]),
		);
		expect(entries.some((e) => e.includes('.partial'))).toBe(false);

		for (const d of Object.values(dirs)) await writeFile(join(d, 'one', 'pack.json'), 'changed');
		await handle.close();
		await restoreBackup({ file: path, dbPath, filesDir, ...dirs });
		for (const d of Object.values(dirs))
			expect(await readFile(join(d, 'one', 'pack.json'), 'utf8')).toBe(`in the backup: ${d}`);
	});

	it('refuses a folder that is not named after what it carries', async () => {
		const { dir, filesDir, handle } = await setup();
		await expect(
			createBackup({
				sqlite: handle.sqlite,
				filesDir,
				themesDir: join(dir, 'looks'),
				backupsDir: join(dir, 'backups'),
				appVersion: '0.0.0-test',
				schema: {},
				reason: 'manual',
			}),
		).rejects.toThrow('themesDir must be named "themes"');
		await handle.close();
	});

	it('leaves the themes alone when restoring a backup made before they were carried', async () => {
		const { dir, dbPath, filesDir, handle } = await setup();
		const themesDir = join(dir, 'themes');
		await mkdir(themesDir, { recursive: true });
		await writeFile(join(themesDir, 'live.json'), 'live');
		const { path } = await createBackup({
			sqlite: handle.sqlite,
			filesDir,
			backupsDir: join(dir, 'backups'),
			appVersion: '0.0.0-test',
			schema: {},
			reason: 'manual',
		});
		await handle.close();
		await restoreBackup({ file: path, dbPath, filesDir, themesDir });
		expect(await readFile(join(themesDir, 'live.json'), 'utf8')).toBe('live');
	});

	it('leaves a marker that points at the moved-aside database, with its journal', async () => {
		const { dir, dbPath, filesDir, handle } = await setup();
		const { path } = await createBackup({
			sqlite: handle.sqlite,
			filesDir,
			backupsDir: join(dir, 'backups'),
			appVersion: '0.0.0-test',
			schema: { core: ['0001_init'] },
			reason: 'manual',
		});
		// A change that only the journal holds yet (the server was stopped without a checkpoint).
		handle.sqlite.pragma('wal_autocheckpoint = 0');
		await sql`update notes set body = 'changed'`.execute(handle.db);
		expect(await readRestoreMarker(dbPath)).toBeNull();

		await restoreBackup({ file: path, dbPath, filesDir });

		const marker = await readRestoreMarker(dbPath);
		expect(marker?.previousPath).toMatch(/famos\.db\.pre-restore-/);
		const aside = openDatabase({ path: marker?.previousPath as string, readonly: true });
		const rows = await sql<{ body: string }>`select body from notes`.execute(aside.db);
		expect(rows.rows).toEqual([{ body: 'changed' }]);
		await aside.close();
		await handle.close();
		await clearRestoreMarker(dbPath);
		expect(await readRestoreMarker(dbPath)).toBeNull();
	});

	it('records that nothing was set aside when the server had no database', async () => {
		const { dir, filesDir, handle } = await setup();
		const { path } = await createBackup({
			sqlite: handle.sqlite,
			filesDir,
			backupsDir: join(dir, 'backups'),
			appVersion: '0.0.0-test',
			schema: { core: ['0001_init'] },
			reason: 'manual',
		});
		await handle.close();
		const target = await mkdtemp(join(tmpdir(), 'famos-new-'));
		await restoreBackup({
			file: path,
			dbPath: join(target, 'famos.db'),
			filesDir: join(target, 'files'),
		});
		expect(await readRestoreMarker(join(target, 'famos.db'))).toMatchObject({
			previousDb: null,
			previousPath: null,
		});
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

	describe('a crafted archive', () => {
		async function backupOf(
			dir: string,
			filesDir: string,
			handle: Awaited<ReturnType<typeof setup>>['handle'],
		) {
			const { path } = await createBackup({
				sqlite: handle.sqlite,
				filesDir,
				backupsDir: join(dir, 'backups'),
				appVersion: '0.0.0-test',
				schema: { core: ['0001_init'] },
				reason: 'manual',
			});
			return path;
		}

		it('is refused when it holds a symbolic link, and the data stays as it was', async () => {
			const { dir, dbPath, filesDir, handle } = await setup();
			await symlink(dir, join(filesDir, 'inbox', 'out'));
			const path = await backupOf(dir, filesDir, handle);
			await handle.close();
			await rm(join(filesDir, 'inbox', 'out'));
			await writeFile(join(filesDir, 'inbox', 'flyer.txt'), 'kept');

			await expect(restoreBackup({ file: path, dbPath, filesDir })).rejects.toThrow(/SymbolicLink/);
			expect(await readFile(join(filesDir, 'inbox', 'flyer.txt'), 'utf8')).toBe('kept');
			expect((await readdir(dir)).filter((n) => n.includes('pre-restore'))).toEqual([]);
		});

		it('is refused when a path climbs out of the target, and nothing is written outside', async () => {
			const { dir, dbPath, filesDir, handle } = await setup();
			const path = await backupOf(dir, filesDir, handle);
			await handle.close();
			const inner = join(dir, 'inner');
			await mkdir(inner);
			await writeFile(join(dir, 'escape.txt'), 'x');
			await tar.r({ file: path, cwd: inner, preservePaths: true }, ['../escape.txt']);
			await rm(join(dir, 'escape.txt'));

			await expect(restoreBackup({ file: path, dbPath, filesDir })).rejects.toThrow(/unsafe path/);
			expect(await readdir(dir)).not.toContain('escape.txt');
		});
	});

	describe('a restore that fails part way', () => {
		/** Every file under a folder with its content, so "unchanged" means byte for byte. */
		async function snapshot(dir: string, rel = ''): Promise<Record<string, string>> {
			const out: Record<string, string> = {};
			for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
				const path = join(rel, entry.name);
				if (path === 'backups') continue;
				if (entry.isDirectory()) Object.assign(out, await snapshot(dir, path));
				else out[path] = (await readFile(join(dir, path))).toString('base64');
			}
			return out;
		}

		async function fixture() {
			const { dir, dbPath, filesDir, handle } = await setup();
			const languagesDir = join(dir, 'languages');
			const themesDir = join(dir, 'themes');
			const extensionsDir = join(dir, 'extensions');
			for (const d of [languagesDir, themesDir, extensionsDir]) {
				await mkdir(d, { recursive: true });
				await writeFile(join(d, 'pack.json'), 'in the backup');
			}
			const { path } = await createBackup({
				sqlite: handle.sqlite,
				filesDir,
				languagesDir,
				themesDir,
				extensionsDir,
				backupsDir: join(dir, 'backups'),
				appVersion: '0.0.0-test',
				schema: { core: ['0001_init'] },
				reason: 'manual',
			});
			// The live data has moved on since.
			await sql`update notes set body = 'live'`.execute(handle.db);
			await writeFile(join(filesDir, 'inbox', 'flyer.txt'), 'live');
			for (const d of [languagesDir, themesDir, extensionsDir])
				await writeFile(join(d, 'pack.json'), 'live');
			await handle.close();
			const options = { file: path, dbPath, filesDir, languagesDir, themesDir, extensionsDir };
			return { dir, options };
		}

		it('leaves the live data exactly as it was, whichever step fails', async () => {
			const probe = await fixture();
			const steps: string[] = [];
			await restoreBackup({ ...probe.options, beforeStep: (name) => void steps.push(name) });
			expect(steps).toEqual(
				expect.arrayContaining(['copy:db', 'copy:files', 'swap:db', 'swap:extensions', 'marker']),
			);

			for (const failing of steps) {
				const { dir, options } = await fixture();
				const before = await snapshot(dir);
				await expect(
					restoreBackup({
						...options,
						beforeStep: (name) => {
							if (name === failing) throw new Error(`injected at ${name}`);
						},
					}),
				).rejects.toThrow(`injected at ${failing}`);
				const after = await snapshot(dir);
				expect(after, failing).toEqual(before);
				expect(await readRestoreMarker(options.dbPath), failing).toBeNull();
			}
		});

		it('leaves the live data when the marker cannot be written', async () => {
			const { dir, options } = await fixture();
			const before = await snapshot(dir);
			// A folder where the marker file goes makes writing it fail after every swap is done.
			await mkdir(join(dir, 'restore-pending.json'));
			await expect(restoreBackup(options)).rejects.toThrow();
			await rm(join(dir, 'restore-pending.json'), { recursive: true });
			expect(await snapshot(dir)).toEqual(before);
		});
	});
});
