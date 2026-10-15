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
		always: false,
		enabled: false,
		dependsOn: staged.dependsOn,
		optional: staged.optional,
		reaches: staged.reaches,
		labels: staged.labels,
		nextVersion: null,
	};
}

/** The versions of an update (the server runs an older one), or null for a new one. */
export const updateOf = (staged: Staged): { from: string; to: string } | null =>
	staged.current && staged.current !== staged.version
		? { from: staged.current, to: staged.version }
		: null;

/** Why the server would not take a file, as a key of the page's texts and its values. */
export interface FileProblem {
	key:
		| 'extensions_file_too_large'
		| 'extensions_file_unsigned'
		| 'extensions_file_incompatible'
		| 'extensions_file_older'
		| 'extensions_file_invalid'
		| 'error_generic';
	values?: Record<string, string>;
	/** The server's own words, shown small below for whoever wants the detail. */
	detail?: string;
}

/** Reads the server's refusal of an uploaded file: its status, its reason and its message. */
export function fileProblem(failure: {
	status: number;
	message?: string;
	details?: unknown;
}): FileProblem {
	const details = (failure.details ?? {}) as { reason?: string; version?: string };
	if (failure.status === 413) return { key: 'extensions_file_too_large' };
	if (failure.status === 409 && details.reason === 'older')
		return { key: 'extensions_file_older', values: { version: details.version ?? '' } };
	if (failure.status !== 400) return { key: 'error_generic' };
	const detail = failure.message ? { detail: failure.message } : {};
	switch (details.reason) {
		case 'too_large':
			return { key: 'extensions_file_too_large', ...detail };
		case 'unsigned':
			return { key: 'extensions_file_unsigned', ...detail };
		case 'incompatible':
			return { key: 'extensions_file_incompatible', ...detail };
		default:
			return { key: 'extensions_file_invalid', ...detail };
	}
}
