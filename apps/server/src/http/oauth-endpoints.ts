import {
	type ClientAuth,
	isOAuthError,
	type Kernel,
	OAUTH_SCOPES,
	type OAuthErrorCode,
	type TokenSet,
} from '@famos/core';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { AppEnv } from './env.ts';
import { errorBody } from './errors.ts';
import { createRateLimiter, type RateLimiter } from './rate-limit.ts';

/**
 * The sign-in endpoints for AI apps: the two metadata documents an app discovers us by, where a
 * person is sent to decide (`/oauth/authorize`), where the app trades a code or a refresh token
 * for tokens (`/oauth/token`) and where it gives them back (`/oauth/revoke`). They read no
 * cookie and run no action: the door admits no caller, it only recognises the app by its own id
 * and secret. Every address in them comes from the family address (`FAMOS_BASE_URL`), never from a
 * request header, so a forged `Host` cannot move the issuer. While signing in is off, or MCP is,
 * each of them answers 404 like `/mcp` does.
 */

/** Large enough for any form an app sends; the rest is refused before it is read. */
const MAX_BODY_BYTES = 16 * 1024;
/** Authorization requests per client address per minute: each one stores a pending request. */
const AUTHORIZE_PER_MINUTE = 60;
const NOT_FOUND = errorBody('not_found', 'Not found');

/** The parameters of the authorization request that must not be repeated. */
const AUTHORIZE_PARAMS = [
	'response_type',
	'client_id',
	'redirect_uri',
	'state',
	'code_challenge',
	'code_challenge_method',
	'scope',
	'resource',
	'prompt',
] as const;

const escapeHtml = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
	);

/** The address with parameters added; used for every answer sent back to the app. */
function withParams(target: string, params: Record<string, string | null | undefined>): string {
	const url = new URL(target);
	for (const [name, value] of Object.entries(params))
		if (value !== null && value !== undefined) url.searchParams.set(name, value);
	return url.toString();
}

/** A page for a problem the app cannot be told about: its redirect address is not trusted. */
function errorPage(message: string): Response {
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>FamilyOS</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:Canvas;color:CanvasText}main{max-width:32rem;margin:0 auto}h1{font-size:1.25rem}</style>
</head>
<body>
<main>
<h1>This app could not be connected</h1>
<p>${escapeHtml(message)}</p>
<p>Nothing was shared. Close this page and start again in the app.</p>
</main>
</body>
</html>`;
	return new Response(body, {
		status: 400,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'content-security-policy':
				"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
			'x-content-type-options': 'nosniff',
			'cache-control': 'no-store',
		},
	});
}

const redirect = (location: string) =>
	new Response(null, {
		status: 303,
		headers: {
			location,
			'cache-control': 'no-store',
			'content-security-policy': "frame-ancestors 'none'",
			// The address of an unknown app's reply never leaves in a Referer.
			'referrer-policy': 'no-referrer',
		},
	});

/** What is sent back to the app when a person says no or a request is wrong. */
export function failureRedirect(
	redirectUri: string,
	issuer: string,
	code: string,
	state: string | null | undefined,
	description?: string,
): string {
	return withParams(redirectUri, {
		error: code,
		error_description: description,
		state,
		iss: issuer,
	});
}

type ClientCredentials = { auth: ClientAuth; basic: boolean };

/** A form-urlencoded part, as RFC 6749 §2.3.1 writes client ids and secrets in a Basic header. */
const formDecode = (text: string) => decodeURIComponent(text.replace(/\+/g, ' '));

const STATUS: Partial<Record<OAuthErrorCode, 400 | 401 | 503>> = {
	invalid_client: 401,
	temporarily_unavailable: 503,
};

function oauthJson(
	c: Context<AppEnv>,
	code: OAuthErrorCode | 'unsupported_grant_type',
	description: string,
	extra: { basic?: boolean } = {},
) {
	const status = STATUS[code as OAuthErrorCode] ?? 400;
	c.header('cache-control', 'no-store');
	c.header('pragma', 'no-cache');
	if (status === 401 && extra.basic) c.header('www-authenticate', 'Basic realm="FamilyOS"');
	return c.json({ error: code, error_description: description }, status);
}

export function mountOAuthEndpoints(
	app: OpenAPIHono<AppEnv>,
	deps: {
		kernel: Kernel;
		clientIp: (c: Context) => string;
		/** Wrong tokens and codes per address; shared with `/mcp`. */
		badTokens: RateLimiter;
	},
): void {
	const { kernel } = deps;
	const oauth = kernel.oauth;
	const authorizeLimit = createRateLimiter({ max: AUTHORIZE_PER_MINUTE, windowMs: 60_000 });

	// Metadata, token and revocation are read by browser-based apps too (an inspector in a web
	// page). They read no cookie, so any origin may call them without credentials.
	const open = cors({
		origin: '*',
		allowMethods: ['GET', 'POST', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Authorization'],
		maxAge: 600,
	});
	const crossOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
		await next();
		// The security headers default to same-origin only; these answers are for other pages.
		c.header('cross-origin-resource-policy', 'cross-origin');
	};
	for (const path of [
		'/.well-known/oauth-protected-resource',
		'/.well-known/oauth-protected-resource/mcp',
		'/.well-known/oauth-authorization-server',
		'/oauth/token',
		'/oauth/revoke',
	]) {
		app.use(path, open);
		app.use(path, crossOrigin);
	}

	// ---- metadata -------------------------------------------------------------------------

	const document =
		(build: (address: { issuer: string; resource: string }) => unknown) =>
		async (c: Context<AppEnv>) => {
			const status = await oauth.status();
			if (!status.active || !status.issuer || !status.resource)
				return c.json(NOT_FOUND, 404, { 'cache-control': 'no-store' });
			return c.json(build({ issuer: status.issuer, resource: status.resource }) as object, 200, {
				'cache-control': 'no-store',
			});
		};

	const resourceDocument = document(({ issuer, resource }) => ({
		resource,
		authorization_servers: [issuer],
		scopes_supported: [...OAUTH_SCOPES],
		bearer_methods_supported: ['header'],
	}));
	app.get('/.well-known/oauth-protected-resource/mcp', resourceDocument);
	app.get('/.well-known/oauth-protected-resource', resourceDocument);
	app.get(
		'/.well-known/oauth-authorization-server',
		document(({ issuer }) => ({
			issuer,
			authorization_endpoint: `${issuer}/oauth/authorize`,
			token_endpoint: `${issuer}/oauth/token`,
			revocation_endpoint: `${issuer}/oauth/revoke`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
			authorization_response_iss_parameter_supported: true,
			scopes_supported: [...OAUTH_SCOPES],
		})),
	);

	// ---- authorize ------------------------------------------------------------------------

	app.get('/oauth/authorize', async (c) => {
		const status = await oauth.status();
		if (!status.active || !status.issuer) return c.json(NOT_FOUND, 404);
		if (!authorizeLimit.hit(deps.clientIp(c)))
			return new Response('Too many sign-in attempts; try again in a minute.', {
				status: 429,
				headers: { 'retry-after': '60', 'cache-control': 'no-store' },
			});

		const url = new URL(c.req.url);
		for (const name of AUTHORIZE_PARAMS)
			if (url.searchParams.getAll(name).length > 1)
				return errorPage('The app sent a request FamilyOS could not read.');
		const query = (name: (typeof AUTHORIZE_PARAMS)[number]) =>
			url.searchParams.get(name) ?? undefined;

		const redirectUri = query('redirect_uri');
		try {
			const { requestId } = await oauth.createRequest({
				clientId: query('client_id') ?? '',
				redirectUri: redirectUri ?? '',
				responseType: query('response_type'),
				state: query('state'),
				codeChallenge: query('code_challenge'),
				codeChallengeMethod: query('code_challenge_method'),
				scope: query('scope'),
				resource: query('resource'),
			});
			// Consent is never skipped: an app that insists on no interaction is told so.
			if ((query('prompt') ?? '').split(/\s+/).includes('none') && redirectUri)
				return redirect(
					failureRedirect(
						redirectUri,
						status.issuer,
						'consent_required',
						query('state'),
						'FamilyOS always asks the person first',
					),
				);
			return redirect(`${status.issuer}/connect/${requestId}`);
		} catch (error) {
			if (!isOAuthError(error)) throw error;
			// Until the app and its return address are checked nothing is sent there.
			if (!error.redirectable || !redirectUri) return errorPage(error.message);
			return redirect(
				failureRedirect(redirectUri, status.issuer, error.code, query('state'), error.message),
			);
		}
	});

	// ---- token and revoke -----------------------------------------------------------------

	const limited = bodyLimit({
		maxSize: MAX_BODY_BYTES,
		onError: (c) =>
			c.json({ error: 'invalid_request', error_description: 'The request is too large' }, 413),
	});
	app.use('/oauth/token', limited);
	app.use('/oauth/revoke', limited);

	/** The form an app posted: once per name, as RFC 6749 asks. Null when it is not a form. */
	async function readForm(c: Context<AppEnv>): Promise<Map<string, string> | null> {
		const type = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
		if (type !== 'application/x-www-form-urlencoded') return null;
		const params = new URLSearchParams(await c.req.text());
		const form = new Map<string, string>();
		for (const name of new Set(params.keys())) {
			const all = params.getAll(name);
			if (all.length > 1) return null;
			form.set(name, all[0] ?? '');
		}
		return form;
	}

	/** How the app proves who it is: a Basic header or the form, never both. */
	function credentials(
		c: Context<AppEnv>,
		form: Map<string, string>,
	): ClientCredentials | 'malformed' | 'ambiguous' | 'missing' {
		const header = /^Basic\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
		if (header) {
			if (form.has('client_secret') || form.has('client_id')) return 'ambiguous';
			let decoded: string;
			try {
				decoded = atob(header[1] as string);
			} catch {
				return 'malformed';
			}
			const colon = decoded.indexOf(':');
			if (colon < 1) return 'malformed';
			try {
				return {
					auth: {
						clientId: formDecode(decoded.slice(0, colon)),
						clientSecret: formDecode(decoded.slice(colon + 1)),
					},
					basic: true,
				};
			} catch {
				return 'malformed';
			}
		}
		const clientId = form.get('client_id');
		if (!clientId) return 'missing';
		return { auth: { clientId, clientSecret: form.get('client_secret') }, basic: false };
	}

	app.post('/oauth/token', async (c) => {
		const status = await oauth.status();
		if (!status.active) return c.json(NOT_FOUND, 404);
		const form = await readForm(c);
		if (!form)
			return oauthJson(
				c,
				'invalid_request',
				'Send the request as application/x-www-form-urlencoded',
			);
		const client = credentials(c, form);
		if (client === 'ambiguous')
			return oauthJson(c, 'invalid_request', 'Send the app’s credentials one way only');
		if (client === 'missing' || client === 'malformed')
			return oauthJson(c, 'invalid_client', 'The app did not say who it is', {
				basic: client === 'malformed' || c.req.header('authorization') !== undefined,
			});

		const bad = async (code: OAuthErrorCode, description: string) => {
			if (!deps.badTokens.hit(deps.clientIp(c))) {
				c.header('retry-after', '60');
				c.header('cache-control', 'no-store');
				return c.json(
					{ error: 'temporarily_unavailable', error_description: 'Too many failed attempts' },
					429,
				);
			}
			return oauthJson(c, code, description, { basic: client.basic });
		};

		try {
			const grant = form.get('grant_type');
			let tokens: TokenSet;
			if (grant === 'authorization_code') {
				const code = form.get('code');
				const redirectUri = form.get('redirect_uri');
				if (!code || !redirectUri)
					return oauthJson(c, 'invalid_request', 'The code and the return address are needed');
				tokens = await oauth.exchangeCode({
					client: client.auth,
					code,
					redirectUri,
					codeVerifier: form.get('code_verifier'),
					resource: form.get('resource'),
				});
			} else if (grant === 'refresh_token') {
				const refreshToken = form.get('refresh_token');
				if (!refreshToken) return oauthJson(c, 'invalid_request', 'The refresh token is needed');
				tokens = await oauth.refresh({
					client: client.auth,
					refreshToken,
					scope: form.get('scope'),
					resource: form.get('resource'),
				});
			} else {
				return oauthJson(
					c,
					'unsupported_grant_type',
					'Only authorization_code and refresh_token are offered',
				);
			}
			c.header('cache-control', 'no-store');
			c.header('pragma', 'no-cache');
			return c.json(
				{
					access_token: tokens.accessToken,
					token_type: tokens.tokenType,
					expires_in: tokens.expiresIn,
					refresh_token: tokens.refreshToken,
					scope: tokens.scope,
				},
				200,
			);
		} catch (error) {
			if (!isOAuthError(error)) throw error;
			if (error.code === 'invalid_client' || error.code === 'invalid_grant')
				return bad(error.code, error.message);
			return oauthJson(c, error.code, error.message, { basic: client.basic });
		}
	});

	app.post('/oauth/revoke', async (c) => {
		const status = await oauth.status();
		if (!status.active) return c.json(NOT_FOUND, 404);
		c.header('cache-control', 'no-store');
		const form = await readForm(c);
		if (!form)
			return oauthJson(
				c,
				'invalid_request',
				'Send the request as application/x-www-form-urlencoded',
			);
		const token = form.get('token');
		if (!token) return oauthJson(c, 'invalid_request', 'The token is needed');
		const client = credentials(c, form);
		// Whatever happens next, the answer is the same: it never tells whether a token was known.
		if (typeof client === 'object') {
			try {
				await oauth.revokeToken({ client: client.auth, token });
			} catch (error) {
				if (!isOAuthError(error)) throw error;
			}
		}
		return c.body(null, 200);
	});
}
