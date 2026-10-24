import { FamosError } from '@famos/sdk';

/**
 * Apps that cannot register themselves but are known well enough to set up in one step: their
 * name, the return addresses they use, whether they can do PKCE, and, for an app that is also
 * reached directly on the home network, where it takes a person back to. The route that sets an
 * app up reads this table and names none of them.
 */
export interface OAuthPreset {
	name: string;
	/** Return addresses every setup of this app uses. */
	redirectUris: readonly string[];
	/** The return address of an app reached at `address` on the home network. */
	callbackAt(address: string): string;
	/** False for an app that cannot send a PKCE challenge. */
	requirePkce: boolean;
}

export const OAUTH_PRESETS = {
	/** Home Assistant signs in through its own cloud relay, and cannot send PKCE. */
	ha: {
		name: 'Home Assistant',
		redirectUris: ['https://my.home-assistant.io/redirect/oauth'],
		callbackAt(address) {
			let url: URL;
			try {
				url = new URL(address);
			} catch {
				throw new FamosError('bad_request', 'The Home Assistant address is not a web address');
			}
			if (url.protocol !== 'https:' && url.protocol !== 'http:')
				throw new FamosError('bad_request', 'The Home Assistant address is not a web address');
			return `${url.origin}${url.pathname.replace(/\/+$/, '')}/auth/external/callback`;
		},
		requirePkce: false,
	},
} as const satisfies Record<string, OAuthPreset>;

export type OAuthPresetId = keyof typeof OAUTH_PRESETS;

export const OAUTH_PRESET_IDS = Object.keys(OAUTH_PRESETS) as [OAuthPresetId, ...OAuthPresetId[]];

/** What setting up a preset creates: its name, return addresses and PKCE rule. */
export function presetClient(
	id: OAuthPresetId,
	options: { name?: string | undefined; address?: string | undefined },
): { name: string; redirectUris: string[]; requirePkce: boolean } {
	const preset: OAuthPreset = OAUTH_PRESETS[id];
	const redirectUris = [...preset.redirectUris];
	if (options.address) redirectUris.push(preset.callbackAt(options.address));
	return { name: options.name ?? preset.name, redirectUris, requirePkce: preset.requirePkce };
}
