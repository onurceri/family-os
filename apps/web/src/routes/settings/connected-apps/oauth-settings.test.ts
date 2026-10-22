import { describe, expect, it } from 'vitest';
import {
	type OAuthState,
	registerBlocked,
	showsHttpSwitch,
	signinBlocked,
	signinBodyKey,
	signinHintKey,
} from './oauth-settings.js';

const state = (patch: Partial<OAuthState> = {}): OAuthState => ({
	oauthEnabled: false,
	dcrEnabled: false,
	allowPlainHttp: false,
	mcpUrl: 'https://family.example/mcp',
	addressProblem: null,
	...patch,
});

describe('the switches for signing in AI apps', () => {
	it('needs the door for AI apps to be open', () => {
		expect(signinBlocked(state(), false)).toBe('mcp_signin_needs_mcp');
		expect(signinBlocked(state(), true)).toBeNull();
	});

	it('says what is wrong with the family address', () => {
		expect(signinBlocked(state({ addressProblem: 'no_address', mcpUrl: null }), true)).toBe(
			'mcp_signin_no_address',
		);
		expect(signinBlocked(state({ addressProblem: 'has_path', mcpUrl: null }), true)).toBe(
			'mcp_signin_has_path',
		);
		expect(signinBlocked(state({ addressProblem: 'plain_http', mcpUrl: null }), true)).toBe(
			'mcp_signin_plain_http',
		);
	});

	it('lets an admin turn it off whatever is wrong', () => {
		expect(
			signinBlocked(state({ oauthEnabled: true, addressProblem: 'has_path' }), false),
		).toBeNull();
	});

	it('lets apps register themselves only while signing in is on', () => {
		expect(registerBlocked(state())).toBe('mcp_register_needs_signin');
		expect(registerBlocked(state({ oauthEnabled: true }))).toBeNull();
	});

	it('shows the http switch only for an http address', () => {
		expect(showsHttpSwitch(state())).toBe(false);
		expect(showsHttpSwitch(state({ addressProblem: 'plain_http', mcpUrl: null }))).toBe(true);
		expect(
			showsHttpSwitch(state({ allowPlainHttp: true, mcpUrl: 'http://home.lan:3000/mcp' })),
		).toBe(true);
		expect(showsHttpSwitch(state({ mcpUrl: 'http://home.lan:3000/mcp' }))).toBe(true);
	});
});

describe('what the address wording says as the settings are', () => {
	const plain = { allowPlainHttp: true, mcpUrl: 'http://home.lan:3000/mcp' };

	it('asks for https until plain http is allowed for an http address', () => {
		expect(signinHintKey(state())).toBe('mcp_signin_hint');
		expect(signinBodyKey(state())).toBe('mcp_signin_page_body');
		expect(signinHintKey(state({ mcpUrl: 'http://home.lan:3000/mcp' }))).toBe('mcp_signin_hint');
		expect(signinBodyKey(state({ mcpUrl: 'http://home.lan:3000/mcp' }))).toBe(
			'mcp_signin_page_body',
		);
	});

	it('says what is true once http is allowed on an http address', () => {
		expect(signinHintKey(state(plain))).toBe('mcp_signin_hint_http');
		expect(signinBodyKey(state(plain))).toBe('mcp_signin_page_body_http');
	});

	it('keeps the https wording for an https address even with the switch on', () => {
		expect(signinBodyKey(state({ allowPlainHttp: true }))).toBe('mcp_signin_page_body');
	});
});
