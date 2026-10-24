import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FamosError, type Logger } from '@famos/sdk';

/** More installed packs than anyone needs; keeps the data directory and the pack list sane. */
export const MAX_INSTALLED_PACKS = 40;

export interface PackEntry {
	source: 'bundled' | 'installed';
	overridesBundled: boolean;
}

export interface PackRegistryOptions<E extends PackEntry> {
	/** What the packs are called in messages and logs: `language`, `theme`. */
	noun: string;
	/** The key a pack's folder is logged under: `code`, `id`. */
	idKey: string;
	logger: Logger;
	/** Packs shipped with the app. */
	bundledDir: string | undefined;
	/** Packs an admin installed. */
	installedDir: string;
	listFolders(root: string): string[];
	/** The order the bundled folders load in (a pack can depend on one loaded before it). */
	orderBundled?(folders: string[]): string[];
	/** Called before every reload, so state derived from the previous load is dropped. */
	beforeReload?(): void;
	/** Reads and validates one pack folder; throws to skip it. */
	read(root: string, folder: string): { id: string; entry: Omit<E, keyof PackEntry> };
	/** Called after a bundled folder loaded. */
	afterBundled?(folder: string, loaded: ReadonlyMap<string, E>): void;
}

export interface PackRegistry<E extends PackEntry> {
	readonly entries: ReadonlyMap<string, E>;
	/** Increases whenever packs are installed, removed or reloaded. */
	readonly version: number;
	reload(): void;
	/**
	 * Writes a pack into its folder under the installed directory and loads it. Refuses when the
	 * installed packs are at the limit and this one would be new.
	 */
	install(id: string, write: (folder: string) => Promise<void>): Promise<E>;
	remove(id: string): Promise<void>;
}

/**
 * The lifecycle language and theme packs share: bundled packs, then installed ones (an installed
 * pack with the same id replaces the bundled one); a pack that fails is skipped and logged, never
 * fatal. What a pack is and how it is validated stays with the caller's `read`.
 */
export function createPackRegistry<E extends PackEntry>(
	options: PackRegistryOptions<E>,
): PackRegistry<E> {
	const { noun, idKey, logger } = options;
	let loaded = new Map<string, E>();
	let version = 0;

	function load(root: string, folder: string, source: E['source'], into: Map<string, E>) {
		try {
			const { id, entry } = options.read(root, folder);
			into.set(id, {
				...entry,
				source,
				overridesBundled: source === 'installed' && into.get(id)?.source === 'bundled',
			} as E);
		} catch (error) {
			logger.warn(
				{ [idKey]: folder, reason: error instanceof Error ? error.message : 'unreadable' },
				`${noun} pack skipped`,
			);
		}
	}

	function reload() {
		const next = new Map<string, E>();
		options.beforeReload?.();
		if (options.bundledDir) {
			const folders = options.listFolders(options.bundledDir);
			for (const folder of options.orderBundled?.(folders) ?? folders) {
				load(options.bundledDir, folder, 'bundled', next);
				options.afterBundled?.(folder, next);
			}
		}
		for (const folder of options.listFolders(options.installedDir)) {
			load(options.installedDir, folder, 'installed', next);
		}
		loaded = next;
		version++;
	}
	reload();

	return {
		get entries() {
			return loaded;
		},
		get version() {
			return version;
		},
		reload,
		async install(id, write) {
			const installedCount = [...loaded.values()].filter((e) => e.source === 'installed').length;
			if (installedCount >= MAX_INSTALLED_PACKS && loaded.get(id)?.source !== 'installed')
				throw new FamosError('conflict', `Too many ${noun} packs are installed`);
			await write(join(options.installedDir, id));
			reload();
			const entry = loaded.get(id);
			if (entry?.source !== 'installed')
				throw new FamosError('unavailable', 'The pack could not be loaded after installing');
			return entry;
		},
		async remove(id) {
			if (loaded.get(id)?.source !== 'installed')
				throw new FamosError('not_found', 'That pack is not installed');
			// The id is a pack's own (validated) id, so the folder name cannot leave the directory.
			await rm(join(options.installedDir, id), { recursive: true, force: true });
			reload();
		},
	};
}
