import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { describeLoaded, readWebPackage, type WebPackage } from '../src/extensions/web.ts';
import { errorBody } from '../src/http/errors.ts';
import {
	contentSecurityPolicy,
	injectShell,
	mountSpa,
	SHARED_MODULES_FILE,
} from '../src/http/static.ts';

const scratch = mkdtempSync(join(tmpdir(), 'famos-static-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SHELL = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>FamilyOS</title>
		<script>document.documentElement.dataset.style = 'broadsheet';</script>
		<link href="/_app/immutable/entry/start.js" rel="modulepreload">
	</head>
	<body><script>import("/_app/immutable/entry/start.js")</script></body>
</html>`;

const SHARED = {
	svelte: '_app/immutable/chunks/svelte.js',
	'@famos/ui/app': '_app/immutable/chunks/app.js',
};

/** A built package with a web half, the way `@famos/pack` writes one. */
function writePackage(id: string, files: Record<string, string>): string {
	const dir = join(scratch, 'extensions', id);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(dir, path, '..'), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	const hashes = Object.fromEntries(
		Object.entries(files).map(([path, text]) => [
			path,
			createHash('sha256').update(text).digest('hex'),
		]),
	);
	writeFileSync(
		join(dir, 'famos-package.json'),
		JSON.stringify({
			format: 1,
			manifest: { id, version: '0.1.0' },
			entries: { server: 'server/index.mjs', web: 'web/index.js', css: 'web/styles.css' },
			files: hashes,
		}),
	);
	return dir;
}

const garden = readWebPackage(
	writePackage('garden', {
		'server/index.mjs': 'export default {}',
		'web/index.js': 'export default { id: "garden" }',
		'web/chunks/page-1.js': 'export const page = 1',
		'web/index.js.map': '{}',
		'web/styles.css': '@layer ext{.garden{color:red}}',
	}),
) as WebPackage;
const loaded = describeLoaded([{ id: 'garden', version: '0.1.0' }], [garden]);

describe('the shell', () => {
	const html = injectShell(SHELL, loaded, SHARED);

	it('maps the shared modules before anything loads a module', () => {
		const map = html.indexOf('<script type="importmap">');
		expect(map).toBeGreaterThan(html.indexOf('<meta charset'));
		expect(map).toBeLessThan(html.indexOf('<title>'));
		for (const tag of ['<script>', 'rel="modulepreload"', 'rel="stylesheet"', '<title>']) {
			expect(html.indexOf(tag)).toBeGreaterThan(map);
		}
		const imports = JSON.parse(
			/<script type="importmap">(.*?)<\/script>/.exec(html)?.[1] ?? '{}',
		).imports;
		expect(imports).toEqual({
			svelte: '/_app/immutable/chunks/svelte.js',
			'@famos/ui/app': '/_app/immutable/chunks/app.js',
		});
	});

	it('lists each package, preloads its entry and links its stylesheet', () => {
		const base = `/extensions/garden/${garden.digest}`;
		const list = JSON.parse(
			/<script type="application\/json" id="famos-extensions">(.*?)<\/script>/.exec(html)?.[1] ??
				'{}',
		);
		expect(list).toEqual({
			fingerprint: loaded.fingerprint,
			extensions: [
				{
					id: 'garden',
					version: '0.1.0',
					entry: `${base}/web/index.js`,
					css: `${base}/web/styles.css`,
					// Source maps stay out of the offline copy.
					files: [`${base}/web/index.js`, `${base}/web/chunks/page-1.js`, `${base}/web/styles.css`],
				},
			],
		});
		expect(html).toContain(`<link rel="modulepreload" href="${base}/web/index.js">`);
		expect(html).toContain(`<link rel="stylesheet" href="${base}/web/styles.css">`);
		// The packages' stylesheets come last, after everything the app loads itself.
		expect(html.indexOf(`${base}/web/styles.css">`)).toBeGreaterThan(
			html.indexOf('/_app/immutable/entry/start.js" rel="modulepreload"'),
		);
		expect(html.indexOf(`${base}/web/styles.css">`)).toBeLessThan(html.indexOf('</head>'));
	});

	it('allows the import map by its hash', () => {
		const map = /<script type="importmap">(.*?)<\/script>/.exec(html)?.[1] ?? '';
		const hash = createHash('sha256').update(map).digest('base64');
		expect(contentSecurityPolicy(html)).toContain(`'sha256-${hash}'`);
	});

	it('cannot be broken out of by what it writes', () => {
		const sneaky = describeLoaded([{ id: 'garden', version: '</script><script>x()' }], [garden]);
		const out = injectShell(
			SHELL,
			{ ...sneaky, packages: [{ ...garden, version: '</script>' }] },
			{},
		);
		expect(out).not.toContain('</script><script>x()');
		const closings = (text: string) => text.match(/<\/script>/g)?.length ?? 0;
		expect(closings(out)).toBe(closings(SHELL) + 2);
	});
});

describe('serving the shell and the packages', () => {
	const webDir = join(scratch, 'web');
	mkdirSync(join(webDir, '_app'), { recursive: true });
	writeFileSync(join(webDir, 'index.html'), SHELL);
	writeFileSync(join(webDir, SHARED_MODULES_FILE), JSON.stringify(SHARED));
	const app = new Hono();
	app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));
	mountSpa(app, webDir, loaded);

	it.each(['/', '/index.html', '/calendar'])(
		'serves %s as the shell, with its policy',
		async (path) => {
			const res = await app.request(path);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain('<script type="importmap">');
			expect(html).toContain('id="famos-extensions"');
			expect(res.headers.get('content-security-policy')).toBe(contentSecurityPolicy(html));
		},
	);

	it.each([
		'/.well-known/oauth-authorization-server',
		'/.well-known/oauth-protected-resource',
		'/.well-known/anything',
	])('answers a probe for %s with a JSON not found, not the shell', async (path) => {
		const res = await app.request(path);
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(res.headers.get('content-security-policy')).toBeNull();
		expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
	});

	it('serves a listed file of a package for good', async () => {
		const res = await app.request(`/extensions/garden/${garden.digest}/web/index.js`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('export default { id: "garden" }');
		expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		const css = await app.request(`/extensions/garden/${garden.digest}/web/styles.css`);
		expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
	});

	it.each([
		['another digest', `/extensions/garden/${'0'.repeat(32)}/web/index.js`],
		['an unknown package', `/extensions/orchard/${garden.digest}/web/index.js`],
		['its server code', `/extensions/garden/${garden.digest}/server/index.mjs`],
		['its description', `/extensions/garden/${garden.digest}/famos-package.json`],
		['a file it does not list', `/extensions/garden/${garden.digest}/web/other.js`],
		['a path out of it', `/extensions/garden/${garden.digest}/web/../../../web/index.html`],
		[
			'an encoded path out of it',
			`/extensions/garden/${garden.digest}/web/%2e%2e/server/index.mjs`,
		],
	])('does not serve %s', async (_what, path) => {
		const res = await app.request(path);
		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain('export default');
	});

	it('refuses to start without the shared modules while packages need them', () => {
		const bare = join(scratch, 'bare');
		mkdirSync(bare, { recursive: true });
		writeFileSync(join(bare, 'index.html'), SHELL);
		expect(() => mountSpa(new Hono(), bare, loaded)).toThrow(/shared-modules\.json is missing/);
		// Without packages (an API-only development setup) there is nothing to map.
		expect(() =>
			mountSpa(new Hono(), bare, describeLoaded([{ id: 'garden', version: '0.1.0' }], [])),
		).not.toThrow();
	});
});

describe('web packages', () => {
	it('has no web half when the package has no web entry', () => {
		const dir = join(scratch, 'extensions', 'quiet');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, 'famos-package.json'),
			JSON.stringify({
				manifest: { id: 'quiet', version: '1.0.0' },
				entries: { server: 'server/index.mjs' },
				files: {},
			}),
		);
		expect(readWebPackage(dir)).toBeUndefined();
	});

	it('refuses an entry the package does not list', () => {
		const dir = join(scratch, 'extensions', 'liar');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, 'famos-package.json'),
			JSON.stringify({
				manifest: { id: 'liar', version: '1.0.0' },
				entries: { server: 'server/index.mjs', web: '../web/index.js' },
				files: { 'web/index.js': 'x' },
			}),
		);
		expect(() => readWebPackage(dir)).toThrow(/does not list/);
	});

	it('changes the fingerprint with a build, not with the order found', () => {
		const a = describeLoaded(
			[
				{ id: 'garden', version: '0.1.0' },
				{ id: 'orchard', version: '1.0.0' },
			],
			[garden],
		);
		const b = describeLoaded(
			[
				{ id: 'orchard', version: '1.0.0' },
				{ id: 'garden', version: '0.1.0' },
			],
			[garden],
		);
		const rebuilt = describeLoaded(
			[
				{ id: 'garden', version: '0.1.0' },
				{ id: 'orchard', version: '1.0.0' },
			],
			[{ ...garden, digest: 'f'.repeat(32) }],
		);
		expect(a.fingerprint).toBe(b.fingerprint);
		expect(rebuilt.fingerprint).not.toBe(a.fingerprint);
	});
});

describe('SPA content security policy', () => {
	it('allows the shell inline scripts by hash and nothing else inline', () => {
		const inline = 'console.log(1)';
		const csp = contentSecurityPolicy(
			`<head><script src="/x.js"></script><script>${inline}</script></head>`,
		);
		const hash = createHash('sha256').update(inline).digest('base64');
		expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
		expect(csp.match(/sha256-/g)).toHaveLength(1);
		expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("object-src 'none'");
	});
});
