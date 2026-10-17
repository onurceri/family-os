import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import { assetUrl, EXTENSION_ASSETS, type LoadedWeb, type WebPackage } from '../extensions/web.ts';

/** Written by the web build: the chunk of the app that provides each module packages share. */
export const SHARED_MODULES_FILE = '_app/shared-modules.json';

/**
 * Serves the built SPA. Hashed assets under /_app/immutable are cached forever; the shell,
 * manifest and service worker are always revalidated so updates reach kiosks. Unknown non-API
 * paths fall back to the shell for client routing. The shell is index.html with the extensions
 * this server runs written into it, so `/` and `/index.html` are never served as the raw file.
 */
// biome-ignore lint/suspicious/noExplicitAny: works with any Hono env.
export function mountSpa(app: Hono<any>, webDir: string, loaded: LoadedWeb): void {
	mountExtensionAssets(app, loaded.packages);
	app.use('/_app/immutable/*', async (c, next) => {
		await next();
		c.header('cache-control', 'public, max-age=31536000, immutable');
	});
	app.use('*', async (c, next) => {
		await next();
		if (!c.res.headers.has('cache-control') && !c.req.path.startsWith('/api/'))
			c.header('cache-control', 'no-cache');
	});
	const files = serveStatic({ root: webDir });
	app.use('*', (c, next) => (isShellPath(c.req.path) ? next() : files(c, next)));

	const shared = readSharedModules(webDir, loaded);
	let shell: { html: string; csp: string } | undefined;
	app.get('*', async (c, next) => {
		if (isNotShell(c.req.path)) return next();
		if (!shell) {
			const raw = await readFile(join(webDir, 'index.html'), 'utf8');
			const html = injectShell(raw, loaded, shared);
			shell = { html, csp: contentSecurityPolicy(html) };
		}
		c.header('content-security-policy', shell.csp);
		return c.html(shell.html);
	});
}

/**
 * Paths the shell must not answer. The API and health check have their own answers. OAuth and MCP
 * clients probe `/.well-known/*` for server metadata and parse the reply as JSON, so an unknown
 * one needs the app's JSON "not found", not the app page with a 200.
 */
const isNotShell = (path: string) =>
	path.startsWith('/api/') || path === '/health' || path.startsWith('/.well-known/');

const isShellPath = (path: string) => path === '/' || path === '/index.html';

/** The app's chunk for each shared module. Packages cannot load without it. */
function readSharedModules(webDir: string, loaded: LoadedWeb): Record<string, string> {
	const file = join(webDir, SHARED_MODULES_FILE);
	if (!existsSync(file)) {
		if (loaded.packages.length === 0) return {};
		throw new Error(
			`${file} is missing: the web app was built without the modules it shares with extension packages`,
		);
	}
	return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
}

/** Inline JSON that cannot end its `<script>` early. */
const inlineJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * Writes the extensions into the shell. First in `<head>` (after the charset), before anything
 * loads a module: the import map that points every shared specifier at the app's own chunk, the
 * list the app imports its extensions from (`famos-extensions`) and a preload of each entry. Last
 * in `<head>`, each package's stylesheet: each states the layer order itself, so where it comes
 * does not change the cascade, and before the app's preloads it would hold them up.
 */
export function injectShell(
	html: string,
	loaded: LoadedWeb,
	shared: Readonly<Record<string, string>>,
): string {
	const imports = Object.fromEntries(
		Object.entries(shared).map(([specifier, file]) => [specifier, `/${file}`]),
	);
	const list = {
		fingerprint: loaded.fingerprint,
		extensions: loaded.packages.map((pkg) => ({
			id: pkg.id,
			version: pkg.version,
			entry: assetUrl(pkg, pkg.entry),
			...(pkg.css && { css: assetUrl(pkg, pkg.css) }),
			// What the app needs offline; source maps are fetched only by developer tools.
			files: pkg.files.filter((path) => !path.endsWith('.map')).map((path) => assetUrl(pkg, path)),
		})),
	};
	const tags = [
		`<script type="importmap">${inlineJson({ imports })}</script>`,
		`<script type="application/json" id="famos-extensions">${inlineJson(list)}</script>`,
		...loaded.packages.map(
			(pkg) => `<link rel="modulepreload" href="${assetUrl(pkg, pkg.entry)}">`,
		),
	].join('\n\t\t');
	const sheets = loaded.packages
		.flatMap((pkg) => (pkg.css ? [`<link rel="stylesheet" href="${assetUrl(pkg, pkg.css)}">`] : []))
		.join('\n\t\t');
	const charset = /<meta\s+charset=[^>]*>/i.exec(html);
	const head = /<head[^>]*>/i.exec(html);
	const at = charset ?? head;
	if (!at) throw new Error('The web shell has no <head>');
	const end = at.index + at[0].length;
	const close = html.lastIndexOf('</head>');
	if (close < end) throw new Error('The web shell has no </head>');
	return `${html.slice(0, end)}\n\t\t${tags}${html.slice(end, close)}\t${sheets}\n\t${html.slice(close)}`;
}

const CONTENT_TYPES: Record<string, string> = {
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
};

/**
 * The files of the extension packages, at `/extensions/<id>/<digest>/<path>`. The digest is of the
 * package description, so an address never changes what it serves and is cached forever. Only
 * the web files a package lists are served, by exact path; anything else is not found.
 */
// biome-ignore lint/suspicious/noExplicitAny: works with any Hono env.
export function mountExtensionAssets(app: Hono<any>, packages: readonly WebPackage[]): void {
	const byId = new Map(packages.map((pkg) => [pkg.id, { pkg, files: new Set(pkg.files) }]));
	app.get(`${EXTENSION_ASSETS}/:id/:digest/*`, async (c) => {
		const found = byId.get(c.req.param('id'));
		if (!found) return c.notFound();
		const prefix = `${EXTENSION_ASSETS}/${found.pkg.id}/${found.pkg.digest}/`;
		const path = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
		if (!found.files.has(path)) return c.notFound();
		const body = await readFile(join(found.pkg.dir, path));
		return c.body(body, 200, {
			'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
			'cache-control': 'public, max-age=31536000, immutable',
			'x-content-type-options': 'nosniff',
		});
	});
}

/**
 * The SPA's policy: only our own scripts, plus the inline scripts of the built shell (SvelteKit's
 * bootstrap, the theme script, the import map) allowed by hash. Styles allow inline because
 * Svelte sets style attributes and components carry their own styles; images allow blob: for
 * local previews (share page) and data: for small icons.
 */
export function contentSecurityPolicy(html: string): string {
	const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
		([, body]) =>
			`'sha256-${createHash('sha256')
				.update(body ?? '')
				.digest('base64')}'`,
	);
	return [
		"default-src 'self'",
		`script-src 'self' ${hashes.join(' ')}`.trim(),
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"connect-src 'self'",
		"font-src 'self'",
		"worker-src 'self'",
		"manifest-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join('; ');
}
