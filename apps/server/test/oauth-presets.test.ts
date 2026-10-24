import { describe, expect, it } from 'vitest';
import { OAUTH_PRESET_IDS, presetClient } from '../src/http/oauth-presets.ts';

describe('OAuth presets', () => {
	it('offers Home Assistant as `ha`', () => {
		expect(OAUTH_PRESET_IDS).toContain('ha');
	});

	it('sets Home Assistant up with its relay address, its own name and no PKCE', () => {
		expect(presetClient('ha', {})).toEqual({
			name: 'Home Assistant',
			redirectUris: ['https://my.home-assistant.io/redirect/oauth'],
			requirePkce: false,
		});
	});

	it('adds the callback of an address on the home network, and lets the name change', () => {
		expect(
			presetClient('ha', { name: 'Hallway', address: 'http://homeassistant.local:8123/' }),
		).toEqual({
			name: 'Hallway',
			redirectUris: [
				'https://my.home-assistant.io/redirect/oauth',
				'http://homeassistant.local:8123/auth/external/callback',
			],
			requirePkce: false,
		});
	});

	it('refuses an address that is not a web address', () => {
		for (const address of ['not a url', 'ftp://homeassistant.local'])
			expect(() => presetClient('ha', { address })).toThrow(/not a web address/);
	});
});
