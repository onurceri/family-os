import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { build, type Plugin } from 'vite';
import { SHARED_WEB } from './shared.ts';
import { buildStyles } from './styles.ts';

/** The web entry and stylesheet of a package, relative to its folder. */
export const WEB_ENTRY = 'web/index.js';
export const WEB_STYLES = 'web/styles.css';

/**
 * Builds an extension's `./web` entry into `web/` of its package: ES modules that leave every
 * shared module (`SHARED_WEB`) to the app's import map and inline the rest (its icons, its
 * contracts' values). Pages stay separate chunks, loaded when first opened. Components carry
 * their own CSS (`css: 'injected'`), so a package has no stylesheet per component, only the
 * utilities it uses in `web/styles.css`. Returns what the bundle imports from the app.
 */
export async function buildWeb(root: string, outDir: string): Promise<string[]> {
	const imports = new Set<string>();
	await build({
		configFile: false,
		root,
		base: './',
		mode: 'production',
		logLevel: 'warn',
		publicDir: false,
		envDir: false,
		plugins: [
			svelte({ configFile: false, emitCss: false, compilerOptions: { css: 'injected' } }),
			collectImports(imports),
		],
		build: {
			outDir: join(outDir, 'web'),
			emptyOutDir: false,
			copyPublicDir: false,
			sourcemap: true,
			// No preload helper: its URLs would be relative to the page, not to the package.
			modulePreload: false,
			reportCompressedSize: false,
			rolldownOptions: {
				input: { index: join(root, 'src/web/index.ts') },
				preserveEntrySignatures: 'strict',
				external: (id) => SHARED_WEB.includes(id),
				// Icon sets are side-effect-free barrels of a thousand or more components; without
				// this every one of them is compiled for each package, only for all but a few to
				// be shaken out afterwards.
				experimental: { lazyBarrel: true },
				output: {
					format: 'es',
					entryFileNames: '[name].js',
					chunkFileNames: 'chunks/[name]-[hash].js',
					assetFileNames: 'assets/[name]-[hash][extname]',
					// What the entry and its pages share (icons, the extension's own helpers) is one
					// chunk, not one per module: the entry loads with the app, and every request counts.
					codeSplitting: { groups: [{ name: 'common', minShareCount: 2 }] },
				},
			},
		},
	});
	await writeFile(join(outDir, WEB_STYLES), await buildStyles(root));
	return [...imports].sort();
}

/** Records the imports the bundle leaves unresolved: what it takes from the app at run time. */
function collectImports(into: Set<string>): Plugin {
	return {
		name: 'famos:collect-imports',
		generateBundle(_options, bundle) {
			for (const output of Object.values(bundle)) {
				if (output.type !== 'chunk') continue;
				for (const id of [...output.imports, ...output.dynamicImports]) {
					if (!(id in bundle)) into.add(id);
				}
			}
		},
	};
}
