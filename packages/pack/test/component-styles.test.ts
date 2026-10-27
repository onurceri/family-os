import { preprocess } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { componentStylesPreprocessor, lowerToTargets } from '../src/component-styles.ts';

const style = async (css: string) => {
	const out = await preprocess(`<div class="a"></div><style>${css}</style>`, [
		componentStylesPreprocessor(),
	]);
	return out.code;
};

describe('component styles for the targets', () => {
	it('prefixes what Chrome 106 knows only with a prefix', async () => {
		const out = await style(
			'.cloud { mask-image: radial-gradient(circle, red, transparent); mask-size: 10px; mask-repeat: no-repeat; }',
		);
		expect(out).toContain('-webkit-mask-image: radial-gradient(');
		expect(out).toContain('-webkit-mask-size: 10px');
		expect(out).toContain('-webkit-mask-repeat: no-repeat');
		expect(out).toContain('  mask-image: radial-gradient(');
	});

	it('flattens nesting and keeps Svelte globals', async () => {
		const out = await style('.a { color: red; &:hover :global(.b) { color: blue; } }');
		expect(out).toContain('.a:hover :global(.b) {');
		expect(out).not.toContain('&');
	});

	it('keeps the vh line before a dvh one, and the color fallbacks', async () => {
		const out = await style(
			'.a { height: 100vh; height: 100dvh; } .b { color: color-mix(in srgb, var(--ink) 30%, transparent); }',
		);
		expect(out).toMatch(/height: 100vh;\s*height: 100dvh;/);
		expect(out).toContain('color: rgb(var(--ink-r) var(--ink-g) var(--ink-b) / .3)');
		expect(out).toContain('@supports (color: color-mix(in srgb, red, red))');
	});

	it('keeps global keyframes', () => {
		expect(lowerToTargets('@keyframes -global-spin { from { opacity: 0 } }')).toContain(
			'@keyframes -global-spin',
		);
	});

	it('refuses a :global block, which flattening would break', () => {
		expect(() =>
			lowerToTargets('.p :global { .y { color: red } }', { filename: 'P.svelte' }),
		).toThrow(/:global\(…\)/);
	});
});
