/**
 * What the switches for AI apps signing in with a family account may do now, and why one is out
 * of reach. The server refuses the same cases; this tells the admin before they try.
 */
export interface OAuthState {
	oauthEnabled: boolean;
	dcrEnabled: boolean;
	allowPlainHttp: boolean;
	mcpUrl: string | null;
	addressProblem: 'no_address' | 'has_path' | 'plain_http' | null;
}

export type Reason =
	| 'mcp_signin_needs_mcp'
	| 'mcp_signin_no_address'
	| 'mcp_signin_has_path'
	| 'mcp_signin_plain_http'
	| 'mcp_register_needs_signin';

/** Why the main switch cannot be turned on (null: it can, or it is on and can be turned off). */
export function signinBlocked(state: OAuthState, mcpOn: boolean): Reason | null {
	if (state.oauthEnabled) return null;
	if (!mcpOn) return 'mcp_signin_needs_mcp';
	if (state.addressProblem === 'no_address') return 'mcp_signin_no_address';
	if (state.addressProblem === 'has_path') return 'mcp_signin_has_path';
	if (state.addressProblem === 'plain_http') return 'mcp_signin_plain_http';
	return null;
}

/** Registering themselves means something only while signing in is on. */
export const registerBlocked = (state: OAuthState): Reason | null =>
	state.oauthEnabled ? null : 'mcp_register_needs_signin';

/**
 * The plain-http switch matters only for an address that is http. It cannot help while there is no
 * address or one with a path, which the main switch says.
 */
export const showsHttpSwitch = (state: OAuthState): boolean =>
	state.addressProblem === 'plain_http' ||
	state.allowPlainHttp ||
	(state.mcpUrl?.startsWith('http://') ?? false);

/**
 * Whether the family address is plain http and the admin has allowed that: apps then reach it
 * without https, so what the screens say about the address must say so too.
 */
export const plainHttpInUse = (state: Pick<OAuthState, 'allowPlainHttp' | 'mcpUrl'>): boolean =>
	state.allowPlainHttp && (state.mcpUrl?.startsWith('http://') ?? false);

/** The hint under the sign-in switch: what the address needs, as the settings are now. */
export const signinHintKey = (
	state: Pick<OAuthState, 'allowPlainHttp' | 'mcpUrl'>,
): 'mcp_signin_hint' | 'mcp_signin_hint_http' =>
	plainHttpInUse(state) ? 'mcp_signin_hint_http' : 'mcp_signin_hint';

/** What the panel for an app that signs in says about the address and which apps can use it. */
export const signinBodyKey = (
	state: Pick<OAuthState, 'allowPlainHttp' | 'mcpUrl'>,
): 'mcp_signin_page_body' | 'mcp_signin_page_body_http' =>
	plainHttpInUse(state) ? 'mcp_signin_page_body_http' : 'mcp_signin_page_body';
