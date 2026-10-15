import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHARED_MODULES_FILE, SHARED_WEB, sharedModules } from '../src/index.ts';

const fixture = join(import.meta.dirname, 'fixtures/app');
const outDir = mkdtempSync(join(tmpdir(), 'famos-shared-'));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

let output: Rolldown.RolldownOutput['output'];
let files: Record<string, string>;

/** The fixture built the way the app is: browser conditions, Svelte, and the plugin. */
beforeAll(async () => {
	const result = (await build({
		configFile: false,
		root: fixture,
		logLevel: 'silent',
		publicDir: false,
		envDir: false,
		plugins: [svelte({ configFile: false, compilerOptions: { css: 'injected' } }), sharedModules()],
		build: {
			outDir,
			emptyOutDir: true,
			modulePreload: false,
			rolldownOptions: {
				input: { main: join(fixture, 'main.js') },
				preserveEntrySignatures: 'strict',
				output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[hash].js' },
			},
		},
	})) as Rolldown.RolldownOutput;
	output = result.output;
	files = JSON.parse(readFileSync(join(outDir, SHARED_MODULES_FILE), 'utf8'));
}, 60_000);

describe('the modules the app shares with extension packages', () => {
	it('lists every shared specifier, each with a chunk of the build', () => {
		expect(Object.keys(files).sort()).toEqual([...SHARED_WEB].sort());
		for (const file of Object.values(files))
			expect(existsSync(join(outDir, file)), file).toBe(true);
	});

	it('keeps every module in one chunk only, so the app and packages share one instance', () => {
		const owners = new Map<string, string[]>();
		for (const chunk of output) {
			if (chunk.type !== 'chunk') continue;
			for (const id of chunk.moduleIds) owners.set(id, [...(owners.get(id) ?? []), chunk.fileName]);
		}
		const twice = [...owners].filter(([, chunks]) => chunks.length > 1);
		expect(twice).toEqual([]);
		// The app's own import of the Svelte runtime reaches the chunk the import map points at.
		const runtime = [...owners].find(([id]) => /svelte\/src\/index-client\.js$/.test(id));
		expect(runtime).toBeDefined();
	});

	it('provides each module with its exports exactly as declared', async () => {
		const ui = (await import(
			pathToFileURL(join(outDir, files['@famos/ui/app'] ?? '')).href
		)) as Record<string, unknown>;
		expect(Object.keys(ui).sort()).toEqual([
			'findApp',
			'namespaced',
			'provideAppContext',
			'useApp',
		]);
	});

	it('provides zod without its message translations, and otherwise whole', async () => {
		const shared = (await import(pathToFileURL(join(outDir, files.zod ?? '')).href)) as Record<
			string,
			// biome-ignore lint/suspicious/noExplicitAny: zod's members are checked by hand here.
			any
		>;
		expect(shared.locales).toBeUndefined();
		expect(shared.z.locales).toBeUndefined();
		expect(shared.core.locales).toBeUndefined();
		expect(shared.z.core.locales).toBeUndefined();
		expect(shared.default).toBe(shared.z);
		expect(shared.z.string).toBe(shared.string);
		expect(shared.z.core).toBe(shared.core);
		expect(typeof shared.core.$ZodType).toBe('function');
		expect(shared.z.enum(['a', 'b']).parse('a')).toBe('a');
		const schema = shared.z.object({ name: shared.z.string() });
		expect(schema.parse({ name: 'Deniz' })).toEqual({ name: 'Deniz' });
		expect(schema instanceof shared.ZodType).toBe(true);
		expect(schema.safeParse({}).error.issues[0].message).toMatch(/expected string/);
		const real = await import('zod');
		const missing = Object.keys(real).filter((name) => !(name in shared));
		expect(missing).toEqual(['locales']);
	});

	it('writes nothing into a build of another environment', () => {
		const plugin = sharedModules();
		const applies = plugin.applyToEnvironment as (env: { name: string }) => boolean;
		expect(applies({ name: 'client' })).toBe(true);
		expect(applies({ name: 'ssr' })).toBe(false);
		expect(applies({ name: 'serviceWorker' })).toBe(false);
	});
});
