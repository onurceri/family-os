import type { ExtensionState } from '@famos/core';
import type { Migrations } from '@famos/sdk';

/**
 * Which extensions to load, before anything is loaded:
 * - the stored state names them (plus whatever is always installed, even if it is new);
 * - with no state but data (a family from before installing existed), every extension that has
 *   data, so an upgrade keeps everything the family used, with no step of its own;
 * - with no state and no data (a new family), the always installed ones and the defaults;
 * - from workspace source (development), everything there.
 */
export function chooseInstalled(input: {
	state: ExtensionState | null;
	/** Applied migrations per scope (`schemaState`). */
	scopes: Readonly<Record<string, readonly string[]>>;
	available: readonly { id: string; always: boolean }[];
	defaults: readonly string[];
	fromSource: boolean;
}): string[] {
	const always = input.available.filter((a) => a.always).map((a) => a.id);
	const ids = (() => {
		if (input.state) return input.state.installed;
		if (input.fromSource) return input.available.map((a) => a.id);
		if (input.scopes.core === undefined) return input.defaults;
		return input.available.filter((a) => (input.scopes[a.id]?.length ?? 0) > 0).map((a) => a.id);
	})();
	return [...new Set([...always, ...ids])].sort();
}

/**
 * Why an extension's migrations cannot run on this database, or null when they can: the database
 * must hold only migrations the package has (else a newer version made it), and every migration
 * still to run must come after the last one applied. Only that extension is refused, not the host.
 */
export function migrationProblem(
	applied: readonly string[] | undefined,
	migrations: Migrations,
): string | null {
	if (!applied || applied.length === 0) return null;
	const unknown = applied.filter((name) => !(name in migrations));
	if (unknown.length > 0)
		return `The database holds migrations this version does not have (${unknown.join(', ')}): a newer version made it`;
	const last = [...applied].sort().at(-1) as string;
	const done = new Set(applied);
	const early = Object.keys(migrations).filter((name) => !done.has(name) && name < last);
	if (early.length > 0) return `Its migration ${early.join(', ')} sorts before the applied ${last}`;
	return null;
}
