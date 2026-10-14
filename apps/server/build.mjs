// Bundles the server into one ESM file. Native and runtime-resolved packages stay external
// and are installed in the production image (see docker/Dockerfile).
import { build } from 'esbuild';

await build({
	entryPoints: ['src/main.ts'],
	outfile: 'dist/main.mjs',
	bundle: true,
	platform: 'node',
	target: 'node24',
	format: 'esm',
	sourcemap: true,
	// node-fetch (inside grammY) recognises an AbortSignal by its class name; without this
	// esbuild renames the polyfill's class to AbortSignal2 and every Telegram call fails.
	keepNames: true,
	external: ['better-sqlite3'],
	// whatwg-url and tr46 (inside node-fetch, inside grammY) require Node's built-in punycode,
	// which is deprecated and warns at every start; the userland package is the same code.
	alias: { punycode: 'punycode/' },
	banner: {
		// Some CJS dependencies call require(); provide it in the ESM bundle.
		js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
	},
	logLevel: 'info',
});
