// Bundles the server into ES modules. Native and runtime-resolved packages stay external and are
// installed in the production image (see docker/Dockerfile).
//
// Besides `main.mjs` (and `famos.mjs`, which supervises it), each module the host shares with extension packages gets an entry of its
// own under `shared/`, listed in `shared/modules.json`; a package's imports of them are pointed
// there when it loads (src/extensions/hooks.ts). With code splitting the entries and main use the
// same chunks, so a package gets the very instance of zod, Kysely, the SDK and time the host runs
// on. Chunks sit beside main.mjs, so files found relative to the bundle (the bundled language,
// theme and extension packs) are found the same way from any of them.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { SHARED_MODULES } from './src/extensions/hooks.ts';

// `@famos/sdk` → shared/sdk.mjs, built from src/shared/sdk.ts.
const SHARED = Object.fromEntries(
	SHARED_MODULES.map((specifier) => [specifier, specifier.split('/').at(-1)]),
);

// Chunk names change with their content; start empty so no stale chunk ships.
await rm('dist', { recursive: true, force: true });

await build({
	entryPoints: [
		{ in: 'src/main.ts', out: 'main' },
		// The image's entry point: runs `serve` under a supervisor that restarts it on request.
		{ in: 'src/famos.ts', out: 'famos' },
		...Object.values(SHARED).map((name) => ({
			in: `src/shared/${name}.ts`,
			out: `shared/${name}`,
		})),
	],
	outdir: 'dist',
	outExtension: { '.js': '.mjs' },
	chunkNames: 'chunk-[hash]',
	splitting: true,
	bundle: true,
	platform: 'node',
	target: 'node24',
	format: 'esm',
	sourcemap: true,
	// One tsconfig for every file: the server reads the web app's English catalog, and that
	// folder's tsconfig extends one SvelteKit only writes when the web app is built.
	tsconfig: 'tsconfig.json',
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

await mkdir('dist/shared', { recursive: true });
await writeFile(
	'dist/shared/modules.json',
	`${JSON.stringify(
		Object.fromEntries(
			Object.entries(SHARED).map(([specifier, name]) => [specifier, `./${name}.mjs`]),
		),
		null,
		'\t',
	)}\n`,
);
