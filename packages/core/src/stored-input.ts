import type { AnyActionDefinition } from '@famos/sdk';

/**
 * A stored draft input (or saved edit) as its action reads it now: what an older version stored
 * goes through the action's `storedInput` first, so a waiting suggestion keeps its meaning after
 * the action's input became stricter. Only for what was stored, never for a new call.
 */
export function readStoredInput(
	def: Pick<AnyActionDefinition, 'storedInput'> | undefined,
	json: string,
): unknown {
	const raw: unknown = JSON.parse(json);
	return def?.storedInput ? def.storedInput(raw) : raw;
}
