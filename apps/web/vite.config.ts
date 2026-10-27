import { fileURLToPath } from 'node:url';
import { colorFallbackPlugin } from '@famos/pack/color-writer';
import { componentStylesPreprocessor } from '@famos/pack/component-styles';
import { BROWSER_TARGETS } from '@famos/pack/targets';
import { sharedModules } from '@famos/pack/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const api = process.env.FAMOS_API ?? 'http://localhost:3000';

/**
 * `@famos/ui`'s components carry their CSS in their JavaScript: extension packages import them
 * from the app's shared chunks, which no stylesheet of the app is tied to.
 */
const ui = fileURLToPath(new URL('../../packages/ui/src/', import.meta.url));

export default defineConfig({
	plugins: [
		tailwindcss(),
		colorFallbackPlugin(BROWSER_TARGETS),
		sveltekit({
			adapter: adapter({ fallback: 'index.html' }),
			preprocess: [componentStylesPreprocessor(BROWSER_TARGETS)],
			dynamicCompileOptions: ({ filename }) =>
				filename.startsWith(ui) ? { css: 'injected' } : undefined,
		}),
		sharedModules(),
	],
	build: { target: BROWSER_TARGETS, cssTarget: BROWSER_TARGETS },
	server: {
		proxy: {
			'/api': { target: api, changeOrigin: false, ws: true },
			'/health': api,
		},
	},
});
