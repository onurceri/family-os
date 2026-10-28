import { transform } from 'lightningcss';
import type { PreprocessorGroup } from 'svelte/compiler';
import { writeColorFallbacks } from './color-writer.ts';
import { BROWSER_TARGETS, lightningTargets, needsColorMixFallback } from './targets.ts';

/**
 * A stylesheet lowered to the browsers built for, as Vite does for stylesheet files: vendor
 * prefixes (`-webkit-mask-image` before Chrome 120), nesting flattened, newer syntax rewritten.
 * Fallback lines written on purpose stay: a `vh` height before a `dvh` one, and the color
 * fallbacks (`color-writer.ts`). Once the targets support everything it changes nothing but the
 * formatting.
 */
export function lowerToTargets(
	css: string,
	options: { targets?: readonly string[]; filename?: string; minify?: boolean } = {},
): string {
	const filename = options.filename ?? 'style.css';
	const result = transform({
		filename,
		code: Buffer.from(css),
		minify: options.minify ?? false,
		targets: lightningTargets(options.targets ?? BROWSER_TARGETS),
		visitor: {
			Selector(selector) {
				// Flattening `:global { … }` would leave a bare `:global`, which Svelte refuses.
				for (const part of selector) {
					if (part.type === 'pseudo-class' && part.kind === 'custom' && part.name === 'global') {
						throw new Error(
							`${filename}: write :global(…) around the selector instead of a :global block, so the style can be lowered for older browsers`,
						);
					}
				}
			},
		},
	});
	return result.code.toString();
}

/**
 * A Svelte preprocessor for every component's `<style>`: the color fallbacks while the targets
 * need them, then lowering to the targets. Components of `@famos/ui` and of extensions carry
 * their CSS inside their JavaScript (`css: 'injected'`), which no stylesheet step of Vite sees,
 * so this is where their CSS meets the targets.
 */
export function componentStylesPreprocessor(
	targets: readonly string[] = BROWSER_TARGETS,
): PreprocessorGroup {
	return {
		name: 'famos:component-styles',
		style({ content, filename }) {
			const file = filename ?? 'component.css';
			const written = needsColorMixFallback(targets)
				? writeColorFallbacks(content, { targets, filename: file })
				: content;
			return { code: lowerToTargets(written, { targets, filename: file }) };
		},
	};
}
