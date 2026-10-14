import { defineExtension, type ExtensionDefinition, SDK_VERSION } from '@famos/sdk';

type Definition = Parameters<typeof defineExtension>[0];

/**
 * `defineExtension` for an extension that lives only in a test. Its manifest is made from the
 * code (the capabilities it declares), so a test names only what it is about; a test of the
 * manifest itself uses `defineExtension` with a written one.
 */
export function defineTestExtension(
	definition: Omit<Definition, 'manifest'> & {
		id: string;
		dependsOn?: string[];
		optional?: string[];
		calls?: string[];
	},
): ExtensionDefinition {
	const { id, dependsOn, optional, calls, ...rest } = definition;
	return defineExtension({
		...rest,
		manifest: {
			id,
			version: '0.0.0',
			sdk: `^${SDK_VERSION}`,
			dependsOn,
			optional,
			calls,
			capabilities: (rest.capabilities ?? []).map((c) => c.id),
		},
	});
}
