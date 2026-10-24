import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StagedPackage } from '@famos/core';
import { FamosError, type Logger } from '@famos/sdk';
import { DAY_MS } from '@famos/time';
import { type Available, type AvailableExtension, readPackage } from '../extensions/load.ts';
import { readArchive, readPackageFolder } from './archive.ts';
import type { TrustRoot } from './trust.ts';
import { type VerifiedPackage, verifyPackage } from './verify.ts';

/** Where uploads wait to be installed, inside the store; not a package id (ids have no dot). */
const STAGING = '.staging';
/** Staged packages nobody installed are removed after a day. */
const STAGED_FOR_MS = DAY_MS;
const DIGEST = /^[0-9a-f]{32}$/;

/** A package in the store, checked again at this start. */
export interface StoredCopy {
	extension: AvailableExtension;
	digest: string;
	dir: string;
	signer: VerifiedPackage['signer'];
	/** When it was placed: of two copies of one version, the later one wins. */
	placedAt: number;
}

export interface StoreScan {
	copies: StoredCopy[];
	/** Copies that failed their check (changed, unsigned, built for another platform) and why. */
	refused: { id: string; digest: string; reason: string }[];
}

export interface ExtensionStore {
	dir: string;
	/** Every stored copy, each checked as it was at install: signature, files, manifest, platform. */
	scan(): Promise<StoreScan>;
	/** Checks an uploaded archive and keeps it aside under its digest. */
	stage(archive: Uint8Array): Promise<StagedPackage>;
	/** A staged package, checked again; undefined when there is none by that digest. */
	staged(digest: string): Promise<StagedPackage | undefined>;
	/** Moves a staged package to `<id>/<digest>/`, checked again first. Idempotent. */
	place(digest: string): Promise<StagedPackage>;
	/**
	 * Removes what no start needs: for each extension the copy it runs (`running`) and the newest
	 * other one are kept (a display still showing the previous version can fetch its files), and
	 * staged uploads older than a day go.
	 */
	collect(running: ReadonlyMap<string, string>, now?: number): Promise<string[]>;
}

/**
 * The extension store: `<data>/extensions/<id>/<digest>/` holds each package placed from an
 * upload (later, from the official index), files exactly as signed plus `famos-package.sig`.
 * Nothing in it is trusted by where it is: every copy is checked against `trustRoots` again at
 * every start.
 */
export function createExtensionStore(options: {
	dir: string;
	trustRoots: readonly TrustRoot[];
	logger?: Logger;
}): ExtensionStore {
	const { dir, trustRoots } = options;
	const stagingDir = (digest: string) => join(dir, STAGING, digest);

	const summary = (pkg: VerifiedPackage): StagedPackage => ({
		digest: pkg.digest,
		id: pkg.id,
		version: pkg.version,
		manifest: pkg.manifest,
		labels: pkg.labels,
		signer: pkg.signer,
	});

	async function checkFolder(folder: string): Promise<VerifiedPackage> {
		return verifyPackage(await readPackageFolder(folder), trustRoots);
	}

	async function exists(path: string): Promise<boolean> {
		return stat(path).then(
			() => true,
			() => false,
		);
	}

	/** Writes the files into a fresh folder beside `target`, then renames it into place. */
	async function writeFolder(pkg: VerifiedPackage, target: string): Promise<void> {
		const temp = `${target}.${randomUUID()}.partial`;
		try {
			for (const [path, bytes] of pkg.files) {
				const file = join(temp, path);
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, bytes, { flag: 'wx' });
			}
			await rename(temp, target).catch(async (error: unknown) => {
				// Two uploads of the same package: the first one's folder is as good.
				if (!(await exists(target))) throw error;
			});
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	}

	async function listDirs(path: string): Promise<string[]> {
		const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	}

	return {
		dir,
		async scan() {
			const copies: StoredCopy[] = [];
			const refused: StoreScan['refused'] = [];
			for (const id of await listDirs(dir)) {
				if (id.startsWith('.')) continue;
				for (const digest of await listDirs(join(dir, id))) {
					if (!DIGEST.test(digest)) continue;
					const folder = join(dir, id, digest);
					try {
						const pkg = await checkFolder(folder);
						if (pkg.id !== id || pkg.digest !== digest)
							throw new Error(`It is stored as ${id}/${digest} but is ${pkg.id}/${pkg.digest}`);
						copies.push({
							extension: readPackage(folder, false),
							digest,
							dir: folder,
							signer: pkg.signer,
							placedAt: (await stat(folder)).mtimeMs,
						});
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						refused.push({ id, digest, reason });
						options.logger?.warn(
							{ extension: id, digest, reason },
							'a stored extension package failed its check and is not used',
						);
					}
				}
			}
			return { copies, refused };
		},
		async stage(archive) {
			const pkg = verifyPackage(await readArchive(archive), trustRoots);
			const target = stagingDir(pkg.digest);
			await mkdir(dirname(target), { recursive: true });
			if (!(await exists(target))) await writeFolder(pkg, target);
			// Staged again: it waits a day from now.
			const now = new Date();
			await utimes(target, now, now);
			return summary(pkg);
		},
		async staged(digest) {
			if (!DIGEST.test(digest)) return undefined;
			const folder = stagingDir(digest);
			if (!(await exists(folder))) return undefined;
			return summary(await checkFolder(folder));
		},
		async place(digest) {
			if (!DIGEST.test(digest)) throw new FamosError('not_found', 'No such uploaded package');
			const from = stagingDir(digest);
			const staged = (await exists(from)) ? await checkFolder(from) : undefined;
			if (!staged) {
				// Placed already (an install that is run again): the stored copy is the answer.
				for (const id of await listDirs(dir)) {
					const folder = join(dir, id, digest);
					if (!id.startsWith('.') && (await exists(folder)))
						return summary(await checkFolder(folder));
				}
				throw new FamosError('not_found', 'No such uploaded package; upload it again');
			}
			const target = join(dir, staged.id, digest);
			await mkdir(dirname(target), { recursive: true });
			if (await exists(target)) await rm(from, { recursive: true, force: true });
			else await rename(from, target);
			// The newest placed copy of a version is the one that runs.
			const now = new Date();
			await utimes(target, now, now);
			return summary(staged);
		},
		async collect(running, now = Date.now()) {
			const removed: string[] = [];
			for (const id of await listDirs(dir)) {
				if (id.startsWith('.')) continue;
				const digests = await listDirs(join(dir, id));
				const dated = await Promise.all(
					digests.map(async (digest) => ({
						digest,
						at: (await stat(join(dir, id, digest))).mtimeMs,
					})),
				);
				const keep = new Set<string>();
				const current = running.get(id);
				if (current) keep.add(current);
				const previous = dated
					.filter((d) => d.digest !== current && DIGEST.test(d.digest))
					.sort((a, b) => b.at - a.at)[0];
				if (previous) keep.add(previous.digest);
				for (const { digest, at } of dated) {
					if (keep.has(digest)) continue;
					// A folder still being written (another process's upload) is left for a day.
					if (!DIGEST.test(digest) && now - at < STAGED_FOR_MS) continue;
					await rm(join(dir, id, digest), { recursive: true, force: true });
					removed.push(`${id}/${digest}`);
				}
			}
			for (const digest of await listDirs(join(dir, STAGING))) {
				const folder = stagingDir(digest);
				const at = (await stat(folder)).mtimeMs;
				if (now - at < STAGED_FOR_MS) continue;
				await rm(folder, { recursive: true, force: true });
				removed.push(`${STAGING}/${digest}`);
			}
			return removed;
		},
	};
}

/** Compares `major.minor.patch` versions. */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) => v.split('.').map(Number);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/**
 * The extensions at hand once the store is added: for each id the highest version among the
 * shipped copy and the stored ones. A shipped copy wins a tie (it is trusted by where it is), so
 * a newer image replaces an older stored copy and a stored copy only runs while it is newer; of
 * two stored copies of one version, the later placed. A stored copy keeps the `always` of the
 * shipped extension it updates.
 */
export function withStore(available: Available, scan: StoreScan): Available {
	const best = new Map<string, { extension: AvailableExtension; copy?: StoredCopy }>();
	for (const extension of available.extensions) best.set(extension.id, { extension });
	const always = new Set(available.extensions.filter((e) => e.always).map((e) => e.id));
	const copies = [...scan.copies].sort((a, b) => a.placedAt - b.placedAt);
	for (const copy of copies) {
		const current = best.get(copy.extension.id);
		const order = current ? compareVersions(copy.extension.version, current.extension.version) : 1;
		const beats = order > 0 || (order === 0 && current?.copy !== undefined);
		if (!beats) continue;
		best.set(copy.extension.id, {
			extension: {
				...copy.extension,
				always: always.has(copy.extension.id),
				stored: { digest: copy.digest, signer: copy.signer },
			},
			copy,
		});
	}
	// An extension whose only copies failed their check has no package: say why it is missing.
	const unreadable = [
		...available.unreadable,
		...scan.refused
			.filter((r) => !best.has(r.id) && !available.unreadable.some((u) => u.id === r.id))
			.filter((r, i, all) => all.findIndex((o) => o.id === r.id) === i)
			.map((r) => ({ id: r.id, reason: r.reason, code: 'package_refused' as const })),
	];
	const order = available.extensions.map((e) => e.id);
	const extensions = [...best.values()]
		.map((b) => b.extension)
		.sort((a, b) => rank(order, a.id) - rank(order, b.id) || a.id.localeCompare(b.id));
	return { ...available, extensions, unreadable };
}

const rank = (order: readonly string[], id: string) => {
	const at = order.indexOf(id);
	return at === -1 ? order.length : at;
};
