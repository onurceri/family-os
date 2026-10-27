import { preprocess } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { colorFallbackPlugin, writeColorFallbacks } from '../src/color-writer.ts';
import { componentStylesPreprocessor } from '../src/component-styles.ts';
import { BROWSER_TARGETS, lightningTargets, needsColorMixFallback } from '../src/targets.ts';

/** Declarations and rules as single lines, for comparing. */
const flat = (css: string) =>
	css
		.replace(/\s+/g, ' ')
		.replace(/ ?([{};:,]) ?/g, '$1')
		.replace(/;}/g, '}')
		.trim();

const MODERN = ['chrome111', 'edge111', 'firefox113', 'safari16.2', 'ios16.2'];

describe('needsColorMixFallback', () => {
	it('is on while a target has no color-mix', () => {
		expect(needsColorMixFallback(BROWSER_TARGETS)).toBe(true);
		expect(needsColorMixFallback(['chrome110'])).toBe(true);
		expect(needsColorMixFallback(['safari16.1'])).toBe(true);
		expect(needsColorMixFallback(['firefox112'])).toBe(true);
		expect(needsColorMixFallback(MODERN)).toBe(false);
		expect(needsColorMixFallback(['chrome130', 'safari17', 'es2022'])).toBe(false);
	});

	it('writes nothing once every target has color-mix', async () => {
		const css = '.a { background: color-mix(in oklab, var(--ink) 10%, transparent); }';
		expect(writeColorFallbacks(css, { targets: MODERN })).toBe(css);
		const pre = componentStylesPreprocessor(MODERN);
		const component = `<div class="a"></div><style>${css}</style>`;
		const out = (await preprocess(component, [pre])).code;
		expect(out).toContain('color-mix(in oklab, var(--ink) 10%, transparent)');
		expect(out).not.toContain('--ink-r');
		const plugin = colorFallbackPlugin(MODERN);
		const transform = plugin.transform as (code: string, id: string) => unknown;
		expect(transform(css, '/x/app.css')).toBeUndefined();
	});

	it('turns targets into lightningcss form', () => {
		expect(lightningTargets(['chrome106', 'ios16.4'])).toEqual({
			chrome: 106 << 16,
			ios_saf: (16 << 16) | (4 << 8),
		});
	});
});

describe('writeColorFallbacks', () => {
	it('writes the fallback in place and the mix again under @supports', () => {
		const css = `.now {
			background: color-mix(in oklab, var(--now) 15%, transparent);
			color: color-mix(in oklab, var(--now) 65%, var(--ink));
			font-weight: 600;
		}
		.interactive:hover { background: color-mix(in oklab, var(--surface) 94%, var(--ink)); }`;
		expect(flat(writeColorFallbacks(css))).toBe(
			flat(`.now {
				background: rgb(var(--now-r) var(--now-g) var(--now-b) / .15);
				color: rgb(calc(var(--now-r) * .65 + var(--ink-r) * .35) calc(var(--now-g) * .65 + var(--ink-g) * .35) calc(var(--now-b) * .65 + var(--ink-b) * .35) / 1);
				font-weight: 600;
			}
			@supports (color: color-mix(in srgb, red, red)) {
				.now {
					background: color-mix(in oklab, var(--now) 15%, transparent);
					color: color-mix(in oklab, var(--now) 65.0%, var(--ink));
				}
			}
			.interactive:hover {
				background: rgb(calc(var(--surface-r) * .94 + var(--ink-r) * .06) calc(var(--surface-g) * .94 + var(--ink-g) * .06) calc(var(--surface-b) * .94 + var(--ink-b) * .06) / 1);
			}
			@supports (color: color-mix(in srgb, red, red)) {
				.interactive:hover { background: color-mix(in oklab, var(--surface) 94.0%, var(--ink)); }
			}`),
		);
	});

	it('replaces each mix of a longer value, inside nesting and Svelte globals', () => {
		const css = `.note :global(.pin) {
			box-shadow: 0 1px 1px color-mix(in srgb, var(--backdrop) 14%, transparent), inset 0 0 0 1px var(--line);
			&:hover { color: color-mix(in srgb, var(--ink) 50%, transparent); }
		}`;
		expect(flat(writeColorFallbacks(css))).toBe(
			// Nesting comes out flattened: the sheet is printed for the targets (Chrome 106 has none).
			flat(`.note :global(.pin) {
				box-shadow: 0 1px 1px rgb(var(--backdrop-r) var(--backdrop-g) var(--backdrop-b) / .14), inset 0 0 0 1px var(--line);
			}
			.note :global(.pin):hover { color: rgb(var(--ink-r) var(--ink-g) var(--ink-b) / .5); }
			@supports (color: color-mix(in srgb, red, red)) {
				.note :global(.pin):hover { color: color-mix(in srgb, var(--ink) 50.0%, transparent); }
			}
			@supports (color: color-mix(in srgb, red, red)) {
				.note :global(.pin) {
					box-shadow: 0 1px 1px color-mix(in srgb, var(--backdrop) 14.0%, transparent), inset 0 0 0 1px var(--line);
				}
			}`),
		);
	});

	it('gives a custom property its fallback and moves the mix under @supports', () => {
		const css = `.sky { --drop: color-mix(in srgb, var(--info) 80%, transparent); --u: 1rem; }`;
		expect(flat(writeColorFallbacks(css))).toBe(
			flat(`.sky {
				--drop: rgb(var(--info-r) var(--info-g) var(--info-b) / .8);
				--drop-r: var(--info-r);
				--drop-g: var(--info-g);
				--drop-b: var(--info-b);
				--drop-a: .8;
				--u: 1rem;
			}
			@supports (color: color-mix(in srgb, red, red)) {
				.sky { --drop: color-mix(in srgb, var(--info) 80.0%, transparent); }
			}`),
		);
	});

	it("puts the fallback after Tailwind's solid color and before its @supports", () => {
		// As Tailwind 4 writes `bg-now/5` and `focus-visible:ring-ring/50` (an extension's sheet).
		const css =
			'.bg-now,.bg-now\\/5{background-color:var(--now)}@supports (color:color-mix(in lab, red, red)){.bg-now\\/5{background-color:color-mix(in oklab, var(--now) 5%, transparent)}}' +
			'.focus-visible\\:ring-ring:focus-visible,.focus-visible\\:ring-ring\\/50:focus-visible{--tw-ring-color:var(--ring)}@supports (color:color-mix(in lab, red, red)){.focus-visible\\:ring-ring\\/50:focus-visible{--tw-ring-color:color-mix(in oklab, var(--ring) 50%, transparent)}}' +
			'.rounded-full{border-radius:3.40282e38px}';
		expect(writeColorFallbacks(css, { minify: true })).toBe(
			'.bg-now,.bg-now\\/5{background-color:var(--now)}' +
				'.bg-now\\/5{background-color:rgb(var(--now-r) var(--now-g) var(--now-b) / .05)}' +
				'@supports (color:color-mix(in lab, red, red)){.bg-now\\/5{background-color:color-mix(in oklab, var(--now) 5.0%, transparent)}}' +
				'.focus-visible\\:ring-ring:focus-visible,.focus-visible\\:ring-ring\\/50:focus-visible{--tw-ring-color:var(--ring)}' +
				'.focus-visible\\:ring-ring\\/50:focus-visible{--tw-ring-color:rgb(var(--ring-r) var(--ring-g) var(--ring-b) / calc(var(--ring-a) * .5))}' +
				'@supports (color:color-mix(in lab, red, red)){.focus-visible\\:ring-ring\\/50:focus-visible{--tw-ring-color:color-mix(in oklab, var(--ring) 50.0%, transparent)}}' +
				'.rounded-full{border-radius:3.40282e38px}',
		);
	});

	it('gives color variables their channels', () => {
		const css = `:root { --ink: #1d1c1a; --scrim: rgb(0 0 0 / 0.5); --primary: var(--ink); --radius: 0.75rem; }
		.board { --lamp: var(--board); --o: 3; --gap: var(--radius); }`;
		const out = flat(writeColorFallbacks(css));
		expect(out).toContain('--ink:#1d1c1a;--ink-r:29;--ink-g:28;--ink-b:26;--ink-a:1;');
		expect(out).toContain('--scrim-r:0;--scrim-g:0;--scrim-b:0;--scrim-a:.502;');
		expect(out).toContain(
			'--primary:var(--ink);--primary-r:var(--ink-r);--primary-g:var(--ink-g);--primary-b:var(--ink-b);--primary-a:1;',
		);
		expect(out).toContain(
			'--lamp:var(--board);--lamp-r:var(--board-r);--lamp-g:var(--board-g);--lamp-b:var(--board-b);--lamp-a:1;',
		);
		expect(out).not.toContain('--radius-r');
		expect(out).not.toContain('--gap-r');
		expect(out).not.toContain('--o-r');
	});

	it('leaves a sheet with nothing to write as it is, and a mix it cannot compute alone', () => {
		const plain = '.a{color:red}\n.b { padding: 1px }';
		expect(writeColorFallbacks(plain)).toBe(plain);
		const unknown = '.a { color: color-mix(in hsl, var(--ink) 10%, red); }';
		expect(writeColorFallbacks(unknown)).toBe(unknown);
	});

	it('writes component styles through the preprocessor', async () => {
		const component =
			'<p class="a">x</p>\n<style>\n\t.a { color: color-mix(in srgb, var(--ink) 30%, transparent); }\n</style>\n';
		const out = (await preprocess(component, [componentStylesPreprocessor()])).code;
		expect(flat(out)).toContain(
			flat(
				'.a { color: rgb(var(--ink-r) var(--ink-g) var(--ink-b) / .3) } @supports (color: color-mix(in srgb, red, red)) { .a { color: color-mix(in srgb, var(--ink) 30%, transparent) } }',
			),
		);
	});

	it('writes app stylesheets through the Vite plugin, but not component styles', () => {
		const transform = colorFallbackPlugin().transform as (
			code: string,
			id: string,
		) => { code: string } | undefined;
		const css = '.a { color: color-mix(in srgb, var(--ink) 30%, transparent); }';
		expect(transform(css, '/app/src/app.css')?.code).toContain('color: rgb(var(--ink-r)');
		expect(transform(css, '/app/src/A.svelte?svelte&type=style&lang.css')).toBeUndefined();
		expect(transform(css, '/app/src/app.css?raw')).toBeUndefined();
		expect(transform('export default 1', '/app/src/a.ts')).toBeUndefined();
	});
});

describe('writeColorFallbacks on hostile input', () => {
	it('answers quickly on a long run of dashes', () => {
		const started = performance.now();
		writeColorFallbacks(`.a { color: red; } /* ${'--'.repeat(50_000)} */`);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
