import type { AiAreaAccess, AiMissingArea } from '@famos/sdk';
import type { ExtensionPackage } from './extension-state.ts';

export interface MissingAreasDeps {
	/** The extensions running now (core aside). */
	loaded: readonly string[];
	/** The packages this server can install, installed or not. */
	packages: readonly ExtensionPackage[];
	isOn(extensionId: string): boolean;
	access(extensionId: string): AiAreaAccess;
	/** Renders a key in a language; a key it does not know comes back as it is. */
	translate(locale: string, key: string): string;
}

/**
 * The areas the AI cannot look into here (see `ActionInvoker.aiMissingAreas`), by id. A running
 * extension's name comes from its own catalog, any other's from its package; English, because
 * prompts are English.
 */
export function aiMissingAreas(deps: MissingAreasDeps, local: boolean): AiMissingArea[] {
	const running = new Set(deps.loaded);
	const label = (id: string) => {
		const pkg = deps.packages.find((p) => p.id === id)?.labels;
		const fromPackage = pkg?.en ?? Object.values(pkg ?? {})[0];
		const own = (key: string) => {
			const text = deps.translate('en', `${id}:${key}`);
			return text === `${id}:${key}` ? undefined : text;
		};
		return {
			name: own('feature_name') ?? fromPackage?.name ?? id,
			description: own('feature_description') ?? fromPackage?.description ?? '',
		};
	};
	const why = (id: string): AiMissingArea['why'] | null => {
		if (!running.has(id)) return 'not_installed';
		if (!deps.isOn(id)) return 'turned_off';
		const access = deps.access(id);
		if (access === 'off' || (access === 'local' && !local)) return 'closed_to_ai';
		return null;
	};
	const ids = [...new Set([...deps.loaded, ...deps.packages.map((p) => p.id)])]
		.filter((id) => id !== 'core')
		.sort();
	return ids.flatMap((id) => {
		const reason = why(id);
		return reason ? [{ id, ...label(id), why: reason }] : [];
	});
}
