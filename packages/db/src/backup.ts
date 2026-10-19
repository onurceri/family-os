import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import * as tar from 'tar';

/**
 * Backup format, modelled on Home Assistant's:
 *   famos-<timestamp>.tar
 *   ├── manifest.json   format, app version, schema state, checksums
 *   ├── db/famos.db     consistent snapshot via VACUUM INTO
 *   ├── files/          attachments
 *   ├── languages/      installed language packs, when there are any
 *   ├── themes/         installed theme packs, when there are any
 *   └── extensions/     extension packages installed from signed files (`<id>/<digest>/`),
 *                       when there are any; uploads not yet installed are left out
 */
export const BACKUP_FORMAT = 1;
const DB_ENTRY = 'db/famos.db';

export interface BackupManifest {
	format: number;
	appVersion: string;
	createdAt: string;
	/** Applied migrations per scope at backup time. */
	schema: Record<string, string[]>;
	db: { sha256: string; size: number };
	reason: 'manual' | 'scheduled' | 'pre-migration';
}

export interface CreateBackupOptions {
	sqlite: Database.Database;
	filesDir: string;
	/** Installed language packs; archived under `languages/` (must be named `languages`). */
	languagesDir?: string;
	/** Installed theme packs; archived under `themes/` (must be named `themes`). */
	themesDir?: string;
	/** The extension store; archived under `extensions/` (must be named `extensions`). */
	extensionsDir?: string;
	backupsDir: string;
	appVersion: string;
	schema: Record<string, string[]>;
	reason: BackupManifest['reason'];
	now?: Date;
}

async function sha256(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, '-');

export async function createBackup(
	options: CreateBackupOptions,
): Promise<{ path: string; manifest: BackupManifest }> {
	const now = options.now ?? new Date();
	await mkdir(options.backupsDir, { recursive: true });
	const staging = await mkdtemp(join(tmpdir(), 'famos-backup-'));
	try {
		const dbPath = join(staging, DB_ENTRY);
		await mkdir(join(staging, 'db'), { recursive: true });
		options.sqlite.prepare('VACUUM INTO ?').run(dbPath);

		const manifest: BackupManifest = {
			format: BACKUP_FORMAT,
			appVersion: options.appVersion,
			createdAt: now.toISOString(),
			schema: options.schema,
			db: { sha256: await sha256(dbPath), size: (await stat(dbPath)).size },
			reason: options.reason,
		};
		await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

		const file = join(options.backupsDir, `famos-${stamp(now)}-${options.reason}.tar`);
		const partial = `${file}.partial`;
		await tar.c({ file: partial, cwd: staging, portable: true }, ['manifest.json', DB_ENTRY]);
		await mkdir(options.filesDir, { recursive: true });
		await tar.r({ file: partial, cwd: join(options.filesDir, '..'), portable: true }, [
			relativeFilesEntry(options.filesDir),
		]);
		if (options.languagesDir) {
			const name = options.languagesDir.replace(/\/+$/, '').split('/').at(-1);
			if (name !== 'languages')
				throw new Error(`languagesDir must be named "languages", got ${options.languagesDir}`);
			await mkdir(options.languagesDir, { recursive: true });
			await tar.r({ file: partial, cwd: join(options.languagesDir, '..'), portable: true }, [name]);
		}
		if (options.themesDir) {
			const name = options.themesDir.replace(/\/+$/, '').split('/').at(-1);
			if (name !== 'themes')
				throw new Error(`themesDir must be named "themes", got ${options.themesDir}`);
			await mkdir(options.themesDir, { recursive: true });
			await tar.r({ file: partial, cwd: join(options.themesDir, '..'), portable: true }, [name]);
		}
		if (options.extensionsDir) {
			const name = options.extensionsDir.replace(/\/+$/, '').split('/').at(-1);
			if (name !== 'extensions')
				throw new Error(`extensionsDir must be named "extensions", got ${options.extensionsDir}`);
			await mkdir(options.extensionsDir, { recursive: true });
			// Uploads waiting to be installed (and folders being written) are not part of the family's
			// setup; only placed packages are.
			await tar.r(
				{
					file: partial,
					cwd: join(options.extensionsDir, '..'),
					portable: true,
					filter: (path) => !/^extensions\/(\.|[^/]+\/[^/]*\.partial(\/|$))/.test(path),
				},
				[name],
			);
		}
		await rename(partial, file);
		return { path: file, manifest };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** The files directory is archived under its own basename, which must be `files`. */
function relativeFilesEntry(filesDir: string): string {
	const name = filesDir.replace(/\/+$/, '').split('/').at(-1);
	if (name !== 'files') throw new Error(`filesDir must be named "files", got ${filesDir}`);
	return name;
}

export async function readBackupManifest(file: string): Promise<BackupManifest> {
	let raw: string | undefined;
	await tar.t({
		file,
		filter: (path) => path === 'manifest.json',
		onReadEntry: (entry) => {
			const chunks: Buffer[] = [];
			entry.on('data', (c: Buffer) => chunks.push(c));
			entry.on('end', () => {
				raw = Buffer.concat(chunks).toString('utf8');
			});
		},
	});
	if (raw === undefined) throw new Error(`${file} is not a FamilyOS backup (no manifest.json)`);
	const manifest = JSON.parse(raw) as BackupManifest;
	if (manifest.format !== BACKUP_FORMAT)
		throw new Error(`Unsupported backup format ${manifest.format}`);
	return manifest;
}

/** The ids of the extension packages a backup carries in its store (`extensions/<id>/…`). */
export async function readBackupExtensions(file: string): Promise<string[]> {
	const ids = new Set<string>();
	await tar.t({
		file,
		filter: (path) => path.startsWith('extensions/'),
		onReadEntry: (entry) => {
			const [, id, , rest] = entry.path.split('/');
			if (id && !id.startsWith('.') && rest === 'famos-package.json') ids.add(id);
			entry.resume();
		},
	});
	return [...ids].sort();
}

export interface RestoreBackupOptions {
	file: string;
	/** Target database file, e.g. /data/famos.db. The server must be stopped. */
	dbPath: string;
	filesDir: string;
	/** Where installed language packs live; restored when the backup carries them. */
	languagesDir?: string;
	/** Where installed theme packs live; restored when the backup carries them. */
	themesDir?: string;
	/** The extension store; restored when the backup carries one. */
	extensionsDir?: string;
	now?: Date;
}

/**
 * Restores a backup over the current data. Existing data is moved aside (never deleted) as
 * `*.pre-restore-<timestamp>`. Schema compatibility is checked by the caller against the code's
 * migrations; pending forward migrations run on next start.
 */
export async function restoreBackup(options: RestoreBackupOptions): Promise<BackupManifest> {
	const manifest = await readBackupManifest(options.file);
	const staging = await mkdtemp(join(tmpdir(), 'famos-restore-'));
	try {
		await tar.x({ file: options.file, cwd: staging });
		const restoredDb = join(staging, DB_ENTRY);
		if ((await sha256(restoredDb)) !== manifest.db.sha256)
			throw new Error('Backup database checksum mismatch');

		const suffix = `pre-restore-${stamp(options.now ?? new Date())}`;
		for (const ext of ['', '-wal', '-shm']) {
			await rename(`${options.dbPath}${ext}`, `${options.dbPath}${ext}.${suffix}`).catch(
				ignoreMissing,
			);
		}
		await rename(options.filesDir, `${options.filesDir}.${suffix}`).catch(ignoreMissing);

		await cp(restoredDb, options.dbPath);
		await cp(join(staging, 'files'), options.filesDir, { recursive: true }).catch(
			async (error: unknown) => {
				if (isMissing(error)) await mkdir(options.filesDir, { recursive: true });
				else throw error;
			},
		);
		if (options.languagesDir) {
			const restored = join(staging, 'languages');
			if (
				await stat(restored).then(
					() => true,
					() => false,
				)
			) {
				await rename(options.languagesDir, `${options.languagesDir}.${suffix}`).catch(
					ignoreMissing,
				);
				await cp(restored, options.languagesDir, { recursive: true });
			}
		}
		if (options.themesDir) {
			const restored = join(staging, 'themes');
			if (
				await stat(restored).then(
					() => true,
					() => false,
				)
			) {
				await rename(options.themesDir, `${options.themesDir}.${suffix}`).catch(ignoreMissing);
				await cp(restored, options.themesDir, { recursive: true });
			}
		}
		// A backup from before the store keeps the store as it is; the server checks every copy
		// in it again at its next start, and leaves out an installed extension it has no package of.
		if (options.extensionsDir) {
			const restored = join(staging, 'extensions');
			if (
				await stat(restored).then(
					() => true,
					() => false,
				)
			) {
				await rename(options.extensionsDir, `${options.extensionsDir}.${suffix}`).catch(
					ignoreMissing,
				);
				await cp(restored, options.extensionsDir, { recursive: true });
			}
		}
		return manifest;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/**
 * How many copies made just before a change to the data (an update, installing an extension) are
 * kept. They have a count of their own, so they never take the places of the nightly ones.
 */
export const KEEP_BEFORE_UPDATE = 3;

/** Keeps the newest `keep` backups of the given reason; returns deleted paths. */
export async function pruneBackups(
	backupsDir: string,
	reason: BackupManifest['reason'],
	keep: number,
): Promise<string[]> {
	const names = (await readdir(backupsDir).catch(() => []))
		.filter((n) => n.startsWith('famos-') && n.endsWith(`-${reason}.tar`))
		.sort()
		.reverse();
	const doomed = names.slice(keep).map((n) => join(backupsDir, n));
	for (const path of doomed) await rm(path, { force: true });
	return doomed;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function ignoreMissing(error: unknown): void {
	if (!isMissing(error)) throw error;
}
