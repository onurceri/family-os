import { join } from 'node:path';
import { compile, optimize } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { packageJsonOf } from './shared.ts';

/** The cascade layer a package's utilities go in: after the app's components, before its utilities. */
export const PACKAGE_LAYER = 'ext';

/**
 * The order of the layers, which the app's stylesheet declares as well. The first stylesheet to
 * name a layer places it, and a package's sheet can load before the app's, so each sheet states
 * the whole order: otherwise `ext` could come first and lose to the app's base.
 */
export const LAYER_ORDER = `@layer properties, theme, base, components, ${PACKAGE_LAYER}, utilities;`;

/**
 * The input of a package's stylesheet. The app owns the theme, the base styles and the type
 * roles and loads them once for everyone, so they are only referenced here: the classes resolve
 * against the same tokens and variants, but nothing of them is written out again. What is
 * written is the utilities the extension's web code uses, in the `ext` layer.
 */
export const STYLES_INPUT = [
	'@reference "tailwindcss";',
	'@reference "@famos/ui/theme.css";',
	'@reference "@famos/ui/styles.css";',
	'@reference "@famos/ui/type.css";',
	`@import "tailwindcss/utilities.css" layer(${PACKAGE_LAYER});`,
	'@source "./src/web";',
	'',
].join('\n');

/**
 * The Tailwind utilities an extension's web code uses, as one minified stylesheet. Theme
 * variables are not repeated: the app writes every one of them (`theme(static)`), so a utility
 * the app itself never uses still finds its value.
 */
export async function buildStyles(root: string): Promise<string> {
	const tailwind = packageJsonOf('tailwindcss').dir;
	const compiler = await compile(STYLES_INPUT, {
		base: root,
		onDependency: () => {},
		// Tailwind is this tool's, not a dependency of each extension; `@famos/ui` is the extension's.
		customCssResolver: async (id) => {
			if (id === 'tailwindcss') return join(tailwind, 'index.css');
			if (id.startsWith('tailwindcss/')) return join(tailwind, id.slice('tailwindcss/'.length));
			return undefined;
		},
	});
	const scanner = new Scanner({ sources: compiler.sources });
	const css = optimize(compiler.build(scanner.scan()), { minify: true }).code;
	return `${LAYER_ORDER}\n${css}`;
}
