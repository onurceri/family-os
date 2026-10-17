/**
 * What the Extensions page shows of the server's list (`core.listExtensions`), as plain data so it
 * is tested without a browser: which section a row belongs to, the name to show, and what an
 * extension reaches beyond its own data.
 */

import type { paths } from '@famos/api-client';

export type ExtensionList =
	paths['/api/v1/core/extensions']['get']['responses'][200]['content']['application/json'];
export type Entry = ExtensionList['extensions'][number];
export type Status = Entry['status'];

/** A name or a description: the app's own catalog when the extension runs, else its package's. */
export interface Texts {
	/** The translated name from the loaded extension's catalog, if it runs. */
	loaded?: { name?: string; description?: string };
	/** The language the page is shown in. */
	language: string;
}

/** The package's texts in the page's language, else in English (every package has English). */
function packageText(entry: Entry, language: string, field: 'name' | 'description') {
	return entry.labels[language]?.[field] ?? entry.labels.en?.[field];
}

export function nameOf(entry: Entry, texts: Texts): string {
	return texts.loaded?.name ?? packageText(entry, texts.language, 'name') ?? entry.id;
}

export function descriptionOf(entry: Entry, texts: Texts): string {
	return texts.loaded?.description ?? packageText(entry, texts.language, 'description') ?? '';
}

/**
 * Installed (anything the family chose, running or not: it has a switch, a state or a reason)
 * and available (what can be installed), each in the order the names give.
 */
export function sections(
	list: readonly Entry[],
	name: (entry: Entry) => string,
): { installed: Entry[]; available: Entry[] } {
	const sorted = [...list].sort((a, b) => name(a).localeCompare(name(b)));
	return {
		installed: sorted.filter((e) => e.status !== 'available'),
		available: sorted.filter((e) => e.status === 'available'),
	};
}

/** What waits for a restart, as the sentence that says who asked for it. */
export type Pending = 'install' | 'uninstall' | 'update';

/** The change an entry waits to apply at the next restart, or null when nothing waits. */
export function pendingOf(entry: Entry): Pending | null {
	if (entry.status === 'pending_install') return 'install';
	if (entry.status === 'pending_uninstall') return 'uninstall';
	return entry.nextVersion ? 'update' : null;
}

const ASKED = {
	install: 'extensions_asked_install',
	uninstall: 'extensions_asked_uninstall',
	update: 'extensions_asked_update',
} as const;

/**
 * "Mara asked to uninstall at 22:16 · waiting for a restart": who asked for a waiting change and
 * when, or null when the server did not record it (a change from before it did). `who` gives a
 * member's name (null for someone who is no longer in the family) and `when` writes the time.
 */
export function askedOf(
	entry: Entry,
	who: (memberId: string) => string | null,
	when: (at: number) => string,
	someone: string,
): Said<(typeof ASKED)[Pending]> | null {
	const pending = pendingOf(entry);
	if (!pending || !entry.changedBy) return null;
	const { memberId, at } = entry.changedBy;
	return {
		key: ASKED[pending],
		values: { who: (memberId ? who(memberId) : null) ?? someone, when: when(at) },
	};
}

/** What the family must know before installing: what installs with it is first among them. */
export interface Reach {
	/** Hosts on the internet it connects to by itself. */
	hosts: string[];
	/** It fetches web addresses someone types in (a calendar link). */
	userUrls: boolean;
	/** It may reach devices on the home network, when someone allows it. */
	local: boolean;
	/** How many permissions it adds for roles. */
	capabilities: number;
	/** The extensions it needs. */
	needs: string[];
	/** What installing it also installs: what it needs, not yet installed (the whole chain). */
	alongside: string[];
	/** Extensions it works with when they are there, without needing them. */
	worksWith: string[];
}

export function reachOf(entry: Entry, list: readonly Entry[]): Reach {
	const byId = new Map(list.map((e) => [e.id, e] as const));
	const alongside: string[] = [];
	// From the entry's own needs: a package from a file is not in the list.
	const visit = (deps: readonly string[]) => {
		for (const dep of deps) {
			if (alongside.includes(dep) || dep === entry.id) continue;
			if (byId.get(dep)?.status !== 'available') continue;
			alongside.push(dep);
			visit(byId.get(dep)?.dependsOn ?? []);
		}
	};
	visit(entry.dependsOn);
	const callees = entry.reaches.calls.map((action) => action.slice(0, action.indexOf('.')));
	const worksWith = [...new Set([...entry.optional, ...callees])].filter(
		(id) => id !== 'core' && id !== entry.id && !entry.dependsOn.includes(id),
	);
	return {
		hosts: entry.reaches.hosts,
		userUrls: entry.reaches.userUrls,
		local: entry.reaches.local,
		capabilities: entry.reaches.capabilities.length,
		needs: entry.dependsOn,
		alongside,
		worksWith,
	};
}

/** It only works inside FamilyOS: no host, no typed address, no home network. */
export const staysInside = (reach: Reach) =>
	reach.hosts.length === 0 && !reach.userUrls && !reach.local;

/** The installed extensions that need this one (it cannot be uninstalled before them). */
export function neededBy(entry: Entry, list: readonly Entry[]): Entry[] {
	return list.filter(
		(other) =>
			other.id !== entry.id &&
			other.status !== 'available' &&
			other.status !== 'pending_uninstall' &&
			other.dependsOn.includes(entry.id),
	);
}

/** Whether the server would load something different after a restart. */
export const restartNeeded = (list: readonly Entry[]) =>
	list.some(
		(e) =>
			e.status === 'pending_install' || e.status === 'pending_uninstall' || e.nextVersion !== null,
	);

/** A package uploaded from a file and checked by the server, waiting for Install. */
export type Staged =
	paths['/api/v1/core/extensions/packages']['post']['responses'][201]['content']['application/json'];

/**
 * A staged package as a row of the list, so the details panel shows it like any extension that
 * can be installed: its name, what it reaches, what installs with it.
 */
export function stagedEntry(staged: Staged): Entry {
	return {
		id: staged.id,
		version: staged.version,
		status: 'available',
		reason: null,
		reasonCode: null,
		reasonParams: {},
		always: false,
		enabled: false,
		dependsOn: staged.dependsOn,
		optional: staged.optional,
		reaches: staged.reaches,
		labels: staged.labels,
		nextVersion: null,
		changedBy: null,
	};
}

/** The versions of an update (the server runs an older one), or null for a new one. */
export const updateOf = (staged: Staged): { from: string; to: string } | null =>
	staged.current && staged.current !== staged.version
		? { from: staged.current, to: staged.version }
		: null;

/** A sentence of the page's texts with the values it names. */
export interface Said<K extends string = string> {
	key: K;
	values?: Record<string, string>;
}

/** The sentences that explain one part of a refused file, by the server's code. */
const FILE_DETAILS = {
	untrusted_key: 'extensions_file_untrusted_key',
	not_signed: 'extensions_file_not_signed',
	bad_signature_file: 'extensions_file_not_signed',
	signature_mismatch: 'extensions_file_signature_mismatch',
	file_mismatch: 'extensions_file_changed',
	file_missing: 'extensions_file_missing',
	unlisted_file: 'extensions_file_unlisted',
	unsafe_path: 'extensions_file_unsafe_path',
	not_a_file: 'extensions_file_not_a_file',
	too_large: 'extensions_file_limit',
	unpacks_too_large: 'extensions_file_unpacked_limit',
	too_many_files: 'extensions_file_too_many',
	sdk: 'extensions_file_sdk',
	platform: 'extensions_file_platform',
	reserved_name: 'extensions_file_reserved',
} as const;

/** Why the server would not take a file: a headline, and what exactly when it is known. */
export interface FileProblem {
	headline: Said<
		| 'extensions_file_too_large'
		| 'extensions_file_unsigned'
		| 'extensions_file_incompatible'
		| 'extensions_file_older'
		| 'extensions_file_invalid'
		| 'error_generic'
	>;
	detail?: Said<(typeof FILE_DETAILS)[keyof typeof FILE_DETAILS]>;
}

/** Only the plain values a sentence names; anything else the server sent is left out. */
function valuesOf(details: Record<string, unknown>): Record<string, string> {
	const values: Record<string, string> = {};
	for (const [name, value] of Object.entries(details))
		if (name !== 'reason' && name !== 'code' && typeof value === 'string') values[name] = value;
	return values;
}

/**
 * Reads the server's refusal of an uploaded file from its status and the codes in its details,
 * never from its words: those are English, for the server's log.
 */
export function fileProblem(failure: { status: number; details?: unknown }): FileProblem {
	const details = (failure.details ?? {}) as Record<string, unknown>;
	if (failure.status === 413) return { headline: { key: 'extensions_file_too_large' } };
	if (failure.status === 409 && details.reason === 'older')
		return {
			headline: {
				key: 'extensions_file_older',
				values: { version: typeof details.version === 'string' ? details.version : '' },
			},
		};
	if (failure.status !== 400) return { headline: { key: 'error_generic' } };
	const headline = (() => {
		switch (details.reason) {
			case 'too_large':
				return 'extensions_file_too_large' as const;
			case 'unsigned':
				return 'extensions_file_unsigned' as const;
			case 'incompatible':
				return 'extensions_file_incompatible' as const;
			default:
				return 'extensions_file_invalid' as const;
		}
	})();
	const code = typeof details.code === 'string' ? details.code : '';
	const detailKey = Object.hasOwn(FILE_DETAILS, code)
		? FILE_DETAILS[code as keyof typeof FILE_DETAILS]
		: undefined;
	return {
		headline: { key: headline },
		...(detailKey && { detail: { key: detailKey, values: valuesOf(details) } }),
	};
}

/** The sentence for each reason an installed extension does not run. */
const PROBLEMS = {
	no_package: 'extensions_problem_no_package',
	package_refused: 'extensions_problem_package_refused',
	unreadable: 'extensions_problem_unreadable',
	load_failed: 'extensions_problem_load_failed',
	newer_data: 'extensions_problem_newer_data',
	migration_order: 'extensions_problem_migration_order',
	migration_failed: 'extensions_problem_migration_failed',
	start_failed: 'extensions_problem_start_failed',
	sdk: 'extensions_problem_sdk',
	missing_dependency: 'extensions_error_missing',
	dependency_refused: 'extensions_problem_dependency_refused',
	name_clash: 'extensions_problem_name_clash',
	invalid: 'extensions_problem_invalid',
} as const satisfies Record<NonNullable<Entry['reasonCode']>, string>;

/**
 * Why an installed extension is left out, in the page's words: by its code, with the extension
 * it names given by its name. Without a code (a record from before codes), a general sentence.
 */
export function problemOf(
	entry: Entry,
	nameOfId: (id: string) => string,
): Said<(typeof PROBLEMS)[keyof typeof PROBLEMS] | 'extensions_problem_unknown'> | null {
	if (entry.status !== 'refused' && entry.status !== 'failed') return null;
	if (!entry.reasonCode) return { key: 'extensions_problem_unknown' };
	const values = { ...entry.reasonParams };
	if (values.extensionId) values.name = nameOfId(values.extensionId);
	return { key: PROBLEMS[entry.reasonCode], values };
}

/** What the last look in the official index found, and the last download from it. */
export type Found =
	paths['/api/v1/core/extensions/found']['get']['responses'][200]['content']['application/json'];
export type FoundPackage = Found['found'][number];
export type FindProblem = NonNullable<NonNullable<Found['search']>['problem']>;

/**
 * A found package as a row of the list, for its name and description: what it reaches is known
 * only once it is downloaded and checked (then it is a staged package).
 */
export function foundEntry(pkg: FoundPackage): Entry {
	return {
		id: pkg.id,
		version: pkg.version,
		status: 'available',
		reason: null,
		reasonCode: null,
		reasonParams: {},
		always: false,
		enabled: false,
		dependsOn: [],
		optional: [],
		reaches: { hosts: [], userUrls: false, local: false, calls: [], capabilities: [] },
		labels: pkg.labels,
		nextVersion: null,
		changedBy: null,
	};
}

/**
 * The page's sections once the index was read: an extension the server offers in an older
 * version than the index is listed once, as found (installing it gets the newest); a found
 * package of an installed extension is an update.
 */
export function withFound(
	grouped: { installed: Entry[]; available: Entry[] },
	found: readonly FoundPackage[],
): { available: Entry[]; found: { pkg: FoundPackage; update: boolean }[] } {
	const foundIds = new Set(found.map((pkg) => pkg.id));
	const installed = new Set(grouped.installed.map((entry) => entry.id));
	return {
		available: grouped.available.filter((entry) => !foundIds.has(entry.id)),
		found: found.map((pkg) => ({ pkg, update: installed.has(pkg.id) })),
	};
}

/** Why looking in the index failed, in the page's words. */
export function searchProblem(
	problem: FindProblem,
): Said<
	| 'extensions_find_unreachable'
	| 'extensions_find_missing'
	| 'extensions_find_unsigned'
	| 'extensions_find_invalid'
	| 'extensions_find_failed'
> {
	switch (problem.reason) {
		case 'unreachable':
			return { key: 'extensions_find_unreachable' };
		case 'missing':
			return { key: 'extensions_find_missing' };
		case 'unsigned':
			return { key: 'extensions_find_unsigned' };
		case 'invalid':
			return { key: 'extensions_find_invalid' };
		default:
			return { key: 'extensions_find_failed' };
	}
}

/** Why a download failed, in the page's words. */
export interface DownloadProblem {
	headline: Said<
		| FileProblem['headline']['key']
		| 'extensions_download_unreachable'
		| 'extensions_download_missing'
		| 'extensions_download_mismatch'
		| 'extensions_download_gone'
		| 'extensions_download_failed'
	>;
	detail?: FileProblem['detail'];
}

/**
 * Why a download failed: the network, or the index's own check (it is not the file the index
 * describes), else what an uploaded file is refused for, said the same way.
 */
export function downloadProblem(problem: FindProblem): DownloadProblem {
	switch (problem.reason) {
		case 'unreachable':
			return { headline: { key: 'extensions_download_unreachable' } };
		case 'missing':
			return { headline: { key: 'extensions_download_missing' } };
		case 'mismatch':
			return { headline: { key: 'extensions_download_mismatch' } };
		case 'gone':
			return { headline: { key: 'extensions_download_gone' } };
		case 'older':
			return fileProblem({ status: 409, details: { reason: 'older', ...problem.params } });
		case 'too_large':
		case 'unsigned':
		case 'incompatible':
		case 'invalid':
			return fileProblem({
				status: 400,
				details: { ...problem.params, reason: problem.reason, code: problem.code },
			});
		default:
			return { headline: { key: 'extensions_download_failed' } };
	}
}
