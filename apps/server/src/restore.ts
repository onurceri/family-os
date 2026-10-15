import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptFile, parseIdentityFile } from '@famos/adapters/backup';
import { readBackupManifest, restoreBackup } from '@famos/db';
import type { ExtensionDefinition } from '@famos/sdk';
import type { Config } from './config.ts';
import { openRuntime } from './runtime.ts';

export interface RestoreOptions {
	/** The extensions this server runs: a backup with migrations none of them knows is refused. */
	extensions: readonly ExtensionDefinition[];
	/** Restore even when the backup is from a newer FamilyOS. */
	force?: boolean;
	/** An age identity file, for backups encrypted to a recipient key. */
	identity?: string;
	/** The passphrase of a passphrase-encrypted backup; asked for when missing. */
	passphrase?: string | undefined;
	/** Asks for the passphrase on a terminal. */
	askPassphrase?: () => Promise<string>;
}

/**
 * `famos restore <file>`: accepts plain `.tar` backups and age-encrypted `.tar.age` ones.
 * An encrypted file is decrypted (streaming) into a temporary folder inside the data directory,
 * which is removed afterwards, and then restored like any other backup.
 */
export async function restoreFile(config: Config, file: string, options: RestoreOptions) {
	let temp: string | undefined;
	try {
		let plain = file;
		if (file.endsWith('.age')) {
			temp = await mkdtemp(join(config.dataDir, '.restore-'));
			plain = join(temp, 'backup.tar');
			const identity = options.identity
				? parseIdentityFile(await readFile(options.identity, 'utf8'))
				: undefined;
			const passphrase = identity
				? undefined
				: (options.passphrase ?? (await options.askPassphrase?.()));
			if (!identity && !passphrase)
				throw new Error(
					'This backup is encrypted. Set FAMOS_BACKUP_PASSPHRASE, use --identity <file>, or run in a terminal to be asked.',
				);
			await decryptFile({
				input: file,
				output: plain,
				...(identity && { identity }),
				...(passphrase && { passphrase }),
			});
		}
		const manifest = await readBackupManifest(plain);
		// Refuse backups made by a newer schema than this code knows.
		const probe = openRuntime(config, { extensions: options.extensions });
		const known = new Map(
			probe.kernel.migrationScopes.map((s) => [s.scope, new Set(Object.keys(s.migrations))]),
		);
		await probe.close();
		const unknown = Object.entries(manifest.schema).flatMap(([scope, names]) =>
			names.filter((n) => !known.get(scope)?.has(n)).map((n) => `${scope}/${n}`),
		);
		if (unknown.length > 0 && !options.force) {
			throw new Error(
				`Backup is from a newer FamilyOS (${manifest.appVersion}); unknown migrations: ${unknown.join(', ')}`,
			);
		}
		await restoreBackup({
			file: plain,
			dbPath: config.dbPath,
			filesDir: config.filesDir,
			languagesDir: config.languagesDir,
			themesDir: config.themesDir,
		});
		return manifest;
	} finally {
		if (temp) await rm(temp, { recursive: true, force: true });
	}
}
