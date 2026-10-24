/**
 * The settings an AI app needs to reach FamilyOS, per kind of app, as the text a person copies
 * into it. FamilyOS speaks MCP over HTTP with the app key sent as a Bearer token.
 */
export type AppKind = 'claude-desktop' | 'claude-code' | 'other';
export const APP_KINDS: readonly AppKind[] = ['claude-desktop', 'claude-code', 'other'];

/** Shown instead of the key once it is no longer known (it is shown only once). */
export const KEY_PLACEHOLDER = 'famos_…';

/** The address an AI app connects to. */
export const mcpAddress = (origin: string): string => `${origin.replace(/\/+$/, '')}/mcp`;

/** What to paste into an app of this kind: a config file entry or a command. */
export function appSettings(kind: AppKind, address: string, key: string | null): string {
	const secret = key ?? KEY_PLACEHOLDER;
	if (kind === 'claude-code')
		// The key is exported first and the command names the variable, so the `claude mcp add`
		// line (the one that is long and often pasted around) holds no key.
		return `export FAMOS_KEY=${secret}\nclaude mcp add --transport http familyos ${address} --header "Authorization: Bearer $FAMOS_KEY"`;
	if (kind === 'claude-desktop')
		// Claude Desktop starts local servers only; mcp-remote bridges it to an address with a header.
		// The header is read from the environment, so the key does not sit in a command line.
		return JSON.stringify(
			{
				mcpServers: {
					familyos: {
						command: 'npx',
						// biome-ignore lint/suspicious/noTemplateCurlyInString: mcp-remote expands it from env.
						args: ['mcp-remote', address, '--header', 'Authorization:${AUTH_HEADER}'],
						env: { AUTH_HEADER: `Bearer ${secret}` },
					},
				},
			},
			null,
			2,
		);
	return JSON.stringify(
		{ mcpServers: { familyos: { url: address, headers: { Authorization: `Bearer ${secret}` } } } },
		null,
		2,
	);
}
