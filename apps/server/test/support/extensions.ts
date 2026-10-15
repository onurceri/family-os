import { join } from 'node:path';
import type { ExtensionDefinition } from '@famos/sdk';
import { loadSourceExtensions } from '../../src/extensions/load.ts';

/** The workspace's extensions folder. */
export const WORKSPACE_EXTENSIONS = join(import.meta.dirname, '../../../../extensions');

let loading: Promise<ExtensionDefinition[]> | undefined;

/**
 * Every extension of the workspace, loaded from its source the way `FAMOS_DEV_EXTENSIONS` loads
 * them: the server names none of them, so tests find them the same way.
 */
export function discoverSourceExtensions(): Promise<ExtensionDefinition[]> {
	loading ??= loadSourceExtensions(WORKSPACE_EXTENSIONS).then((loaded) => loaded.extensions);
	return loading;
}

/** The workspace's extensions with these ids, in the order given. */
export async function sourceExtensions<const Ids extends readonly string[]>(
	...ids: Ids
): Promise<{ [K in keyof Ids]: ExtensionDefinition }> {
	const all = await discoverSourceExtensions();
	return ids.map((id) => {
		const found = all.find((ext) => ext.id === id);
		if (!found) throw new Error(`No extension "${id}" in ${WORKSPACE_EXTENSIONS}`);
		return found;
	}) as { [K in keyof Ids]: ExtensionDefinition };
}
