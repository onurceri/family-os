import {
	defineExtension,
	type ExtensionDefinition,
	type ExtensionManifestInput,
	SDK_VERSION,
} from '@famos/sdk';

type Definition = Parameters<typeof defineExtension>[0];

/**
 * `defineExtension` for an extension that lives only in a test. Its manifest is made from the
 * code (the capabilities it declares, the host contracts it provides), so a test names only
 * what it is about; a test of the
 * manifest itself uses `defineExtension` with a written one.
 */
export function defineTestExtension(
	definition: Omit<Definition, 'manifest'> & {
		id: string;
		dependsOn?: string[];
		optional?: string[];
		calls?: string[];
		network?: ExtensionManifestInput['network'];
	},
): ExtensionDefinition {
	const { id, dependsOn, optional, calls, network, ...rest } = definition;
	return defineExtension({
		...rest,
		manifest: {
			id,
			version: '0.0.0',
			sdk: `^${SDK_VERSION}`,
			dependsOn,
			optional,
			calls,
			network,
			capabilities: (rest.capabilities ?? []).map((c) => c.id),
			provides: [
				...(rest.shareTarget ? ['shareTarget'] : []),
				...(rest.conversation ? ['conversation'] : []),
			],
		},
	});
}
