import { satisfiesRange } from '@famos/i18n';
import { z } from 'zod';
import { colorChannels, contrastRatio, parseColor, type Rgba, serializeColor } from './color.ts';
import {
	BODY_FONTS,
	BUNDLED_FONTS,
	type BundledFont,
	CONTRAST_RULES,
	cssVariable,
	MODE_TOKEN_NAMES,
	MODE_TOKENS,
	type ModeToken,
	SHARED_TOKENS,
} from './tokens.ts';

/**
 * Theme packs: appearance as data. A pack is a manifest, the values of the known
 * tokens for the day and the night palette, and optional font files. It is validated here before
 * anything uses it, and the stylesheet browsers get is generated from the validated numbers
 * (`renderStylesheet`), never from the pack's text.
 */

/** Largest pack, fonts included, in decoded bytes. */
export const MAX_PACK_BYTES = 1536 * 1024;
/** Largest single font file. */
export const MAX_FONT_BYTES = 400 * 1024;
export const MAX_FONT_FILES = 8;

const FONT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,78}\.woff2$/;
const FONT_FAMILY = /^[A-Za-z][A-Za-z0-9 _-]{0,59}$/;

const FontFaceSchema = z.object({
	/** A `.woff2` file of the pack. */
	file: z.string().regex(FONT_FILE, 'Expected a file name ending in .woff2'),
	/** One weight (`400`) or a range of a variable font (`100 900`). */
	weight: z
		.string()
		.regex(/^[1-9]00( [1-9]00)?$/, 'Expected a weight like 400 or 100 900')
		.default('400'),
	style: z.enum(['normal', 'italic']).default('normal'),
});

export const PackManifestSchema = z.object({
	/** Lowercase letters, digits and hyphens; also the pack's folder name. */
	id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'Use lowercase letters, digits and hyphens'),
	name: z.string().trim().min(1).max(80),
	/** The pack's own version (semver): shown in Appearance and used for cache validation. */
	version: z
		.string()
		.regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'Expected a version like 1.0.0'),
	/** The app versions the pack was made for, as a semver range such as `>=0.1.0`. */
	famos: z.string().trim().min(1).max(100),
	authors: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
	/** Typefaces the pack ships: family name → its files. */
	fonts: z
		.record(
			z.string().regex(FONT_FAMILY, 'Letters, digits, spaces, hyphens and underscores only'),
			z.array(FontFaceSchema).min(1).max(8),
		)
		.optional(),
	/**
	 * The style the pack suggests, one of the app's bundled style ids. Used only while
	 * the family has never chosen a style; an id the app does not know is reported and ignored.
	 */
	style: z
		.string()
		.regex(/^[a-z][a-z0-9-]{1,39}$/, 'Use lowercase letters, digits and hyphens')
		.optional(),
});
export type PackManifest = z.infer<typeof PackManifestSchema>;

/** A pack as found on disk or sent by a client, before validation. Fonts are base64 by file name. */
export interface RawThemePack {
	manifest: unknown;
	tokens: unknown;
	fonts?: Record<string, string> | undefined;
}

/** Token values in their canonical form (what the stylesheet is built from). */
export interface ThemeTokens {
	day: Record<ModeToken, string>;
	night: Record<ModeToken, string>;
	radius: string;
	/** The body font: a bundled family, `system` or one of the pack's own. */
	font: string;
	/** The display and serif fonts; `''` means the style's default. */
	'font-display': string;
	'font-serif': string;
}

export interface ThemePack {
	manifest: PackManifest;
	tokens: ThemeTokens;
	/** Font files by name, as bytes (checked to be WOFF2). */
	fonts: Record<string, Uint8Array>;
}

export type ThemeValidation =
	| { ok: true; pack: ThemePack; warnings: string[] }
	| { ok: false; errors: string[] };

export interface ValidateOptions {
	/** The app version the pack must be made for. */
	appVersion?: string;
	/** The default theme's tokens: what a pack that leaves a token out gets. */
	fallback?: ThemeTokens;
	/** The style ids the app ships: a preferred `style` outside them is warned about and dropped. */
	styles?: readonly string[];
}

// -- Value grammars ------------------------------------------------------------------------------

/** Splits at `separator` outside parentheses. */
function splitTopLevel(text: string, separator: ',' | ' '): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of text) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		const isSeparator = separator === ' ' ? /\s/.test(ch) : ch === ',';
		if (isSeparator && depth === 0) {
			if (current) parts.push(current);
			current = '';
		} else current += ch;
	}
	if (current) parts.push(current);
	return parts.map((p) => p.trim()).filter(Boolean);
}

const LENGTH = /^(-?\d+(?:\.\d+)?)(px|rem)?$/;

/** A length in px or rem (a bare 0 is allowed), as `{ value, unit }`. */
function parseLength(text: string): { value: number; unit: 'px' | 'rem' } | null {
	const m = LENGTH.exec(text);
	if (!m) return null;
	const value = Number(m[1]);
	if (!Number.isFinite(value)) return null;
	if (!m[2] && value !== 0) return null;
	return { value, unit: (m[2] as 'px' | 'rem' | undefined) ?? 'px' };
}

const lengthCss = (l: { value: number; unit: string }) =>
	l.value === 0 ? '0' : `${l.value}${l.unit}`;
const inPx = (l: { value: number; unit: 'px' | 'rem' }) =>
	l.unit === 'rem' ? l.value * 16 : l.value;

/** `0.75rem`, `12px`: 0 to 2rem. */
export function parseRadius(text: unknown): string | null {
	if (typeof text !== 'string') return null;
	const length = parseLength(text.trim());
	if (!length || length.value < 0 || inPx(length) > 32) return null;
	return lengthCss(length);
}

/** `none`, or up to four comma-separated layers of `[inset] x y [blur [spread]] color`. */
export function parseShadow(text: unknown): string | null {
	if (typeof text !== 'string') return null;
	const value = text.trim();
	if (value === 'none') return 'none';
	const layers = splitTopLevel(value, ',');
	if (layers.length === 0 || layers.length > 4) return null;
	const out: string[] = [];
	for (const layer of layers) {
		const tokens = splitTopLevel(layer, ' ');
		const inset = tokens[0] === 'inset';
		if (inset) tokens.shift();
		const colorText = tokens.pop();
		if (!colorText || tokens.length < 2 || tokens.length > 4) return null;
		const lengths = tokens.map(parseLength);
		if (lengths.some((l) => l === null)) return null;
		const sized = lengths as { value: number; unit: 'px' | 'rem' }[];
		if (sized.some((l) => Math.abs(inPx(l)) > 64)) return null;
		if (sized[2] && sized[2].value < 0) return null;
		const color = parseColor(colorText);
		if (!color) return null;
		out.push(`${inset ? 'inset ' : ''}${sized.map(lengthCss).join(' ')} ${serializeColor(color)}`);
	}
	return out.join(', ');
}

function decodeBase64(text: string): Uint8Array | null {
	if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
	try {
		return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

const isWoff2 = (bytes: Uint8Array) =>
	bytes.length > 44 &&
	bytes[0] === 0x77 &&
	bytes[1] === 0x4f &&
	bytes[2] === 0x46 &&
	bytes[3] === 0x32;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

// -- Validation ----------------------------------------------------------------------------------

const MODES = ['day', 'night'] as const;

function readMode(
	mode: (typeof MODES)[number],
	raw: unknown,
	fallback: ThemeTokens | undefined,
	errors: string[],
	warnings: string[],
	explicit: Set<ModeToken>,
): Record<ModeToken, string> | null {
	if (raw !== undefined && !isRecord(raw)) {
		errors.push(`tokens.${mode} must be an object of token values`);
		return null;
	}
	const given = raw ?? {};
	for (const name of Object.keys(given)) {
		if (name !== '$schema' && !(name in MODE_TOKENS))
			warnings.push(`Unknown token "${name}" in ${mode} is ignored`);
	}
	const out = {} as Record<ModeToken, string>;
	let ok = true;
	for (const name of MODE_TOKEN_NAMES) {
		const info = MODE_TOKENS[name];
		const value = given[name];
		if (value !== undefined) explicit.add(name);
		if (value === undefined) {
			const inherited = fallback?.[mode][name];
			if (inherited === undefined) {
				errors.push(`Missing token "${name}" in ${mode}`);
				ok = false;
			} else out[name] = inherited;
			continue;
		}
		if (info.kind === 'shadow') {
			const shadow = parseShadow(value);
			if (shadow === null) {
				errors.push(`Token "${name}" in ${mode} is not a valid shadow: ${JSON.stringify(value)}`);
				ok = false;
			} else out[name] = shadow;
			continue;
		}
		const color = typeof value === 'string' ? parseColor(value) : null;
		if (!color) {
			errors.push(
				`Token "${name}" in ${mode} is not a color (use #rrggbb, rgb() or oklch()): ${JSON.stringify(value)}`,
			);
			ok = false;
		} else if (color.a < 1 && !('alpha' in info && info.alpha)) {
			errors.push(`Token "${name}" in ${mode} must be opaque`);
			ok = false;
		} else out[name] = serializeColor(color);
	}
	return ok ? out : null;
}

/**
 * The contrast failures of a theme, as plain sentences. With `explicit` (the tokens a pack set
 * itself, per palette) only the pairs it touched are checked: what it inherited from the default
 * theme is the default's business, not the pack's.
 */
export function contrastProblems(
	tokens: ThemeTokens,
	explicit?: Record<'day' | 'night', ReadonlySet<ModeToken>>,
): string[] {
	const problems: string[] = [];
	for (const mode of MODES) {
		for (const rule of CONTRAST_RULES) {
			const set = explicit?.[mode];
			if (set && !set.has(rule.foreground) && !set.has(rule.background)) continue;
			const fg = parseColor(tokens[mode][rule.foreground]) as Rgba;
			const bg = parseColor(tokens[mode][rule.background]) as Rgba;
			const ratio = contrastRatio(fg, bg);
			if (ratio < rule.min) {
				problems.push(
					`Contrast: ${rule.foreground} on ${rule.background} (${mode}) is ${ratio.toFixed(1)}:1, needs ${rule.min}:1`,
				);
			}
		}
	}
	return problems;
}

/**
 * Validates a pack from untrusted input. Errors refuse the pack and are all listed at once;
 * warnings (unknown tokens, unused fonts) do not stop it from loading.
 */
export function validateThemePack(input: unknown, options: ValidateOptions = {}): ThemeValidation {
	if (!isRecord(input)) return { ok: false, errors: ['Not a theme pack'] };
	const errors: string[] = [];
	const warnings: string[] = [];
	const rawFonts = input.fonts;
	if (rawFonts !== undefined && !isRecord(rawFonts))
		return { ok: false, errors: ['The fonts must be an object of base64 files'] };

	// Sizes first: nothing below should work on something enormous.
	let size = 0;
	try {
		size = JSON.stringify([input.manifest, input.tokens]).length;
	} catch {
		return { ok: false, errors: ['Not a theme pack'] };
	}
	for (const value of Object.values(rawFonts ?? {})) {
		if (typeof value !== 'string') return { ok: false, errors: ['The fonts must be base64 text'] };
		size += (value.length / 4) * 3;
	}
	if (size > MAX_PACK_BYTES)
		return { ok: false, errors: [`The pack is larger than ${MAX_PACK_BYTES / 1024 / 1024} MB`] };

	const manifest = PackManifestSchema.safeParse(input.manifest);
	if (!manifest.success) {
		for (const issue of manifest.error.issues)
			errors.push(`Invalid manifest (${issue.path.join('.') || 'manifest'}: ${issue.message})`);
	} else if (options.appVersion && !satisfiesRange(options.appVersion, manifest.data.famos)) {
		errors.push(
			`The pack is made for FamilyOS ${manifest.data.famos}, this is ${options.appVersion}`,
		);
	}

	// Fonts: only WOFF2, each within its cap, and every family in the manifest has its files.
	const fonts: Record<string, Uint8Array> = {};
	const names = Object.keys(rawFonts ?? {});
	if (names.length > MAX_FONT_FILES)
		errors.push(`At most ${MAX_FONT_FILES} font files are allowed`);
	for (const name of names.slice(0, MAX_FONT_FILES)) {
		if (!FONT_FILE.test(name)) {
			errors.push(`Font file "${name}": only .woff2 files with a plain name are allowed`);
			continue;
		}
		const bytes = decodeBase64((rawFonts as Record<string, string>)[name] as string);
		if (!bytes) errors.push(`Font file "${name}" is not valid base64`);
		else if (bytes.length > MAX_FONT_BYTES)
			errors.push(`Font file "${name}" is larger than ${MAX_FONT_BYTES / 1024} KB`);
		else if (!isWoff2(bytes)) errors.push(`Font file "${name}" is not a WOFF2 font`);
		else fonts[name] = bytes;
	}
	const declared = new Set<string>();
	if (manifest.success) {
		for (const [family, faces] of Object.entries(manifest.data.fonts ?? {})) {
			if ((BUNDLED_FONTS as readonly string[]).includes(family))
				errors.push(`The font name "${family}" is reserved`);
			for (const face of faces) {
				declared.add(face.file);
				if (!names.includes(face.file))
					errors.push(`Font "${family}" names ${face.file}, which is not in the pack`);
			}
		}
		for (const name of Object.keys(fonts))
			if (!declared.has(name)) warnings.push(`Font file "${name}" is not used by the manifest`);
	}

	// Tokens.
	let tokens: ThemeTokens | null = null;
	const explicit = { day: new Set<ModeToken>(), night: new Set<ModeToken>() };
	if (!isRecord(input.tokens)) errors.push('tokens must be an object with day and night values');
	else {
		for (const key of Object.keys(input.tokens)) {
			if (key !== '$schema' && key !== 'day' && key !== 'night' && !(key in SHARED_TOKENS))
				warnings.push(`Unknown token "${key}" is ignored`);
		}
		const day = readMode('day', input.tokens.day, options.fallback, errors, warnings, explicit.day);
		const night = readMode(
			'night',
			input.tokens.night,
			options.fallback,
			errors,
			warnings,
			explicit.night,
		);

		let radius = options.fallback?.radius;
		if (input.tokens.radius !== undefined) {
			const parsed = parseRadius(input.tokens.radius);
			if (parsed === null)
				errors.push(
					`Token "radius" must be a length from 0 to 2rem: ${JSON.stringify(input.tokens.radius)}`,
				);
			else radius = parsed;
		} else if (radius === undefined) errors.push('Missing token "radius"');

		const own = manifest.success ? Object.keys(manifest.data.fonts ?? {}) : [];
		let font = options.fallback?.font;
		if (input.tokens.font !== undefined) {
			const wanted = input.tokens.font;
			if (typeof wanted !== 'string' || !([...BODY_FONTS, ...own] as string[]).includes(wanted)) {
				errors.push(
					`Token "font" must be one of: ${[...BODY_FONTS, ...own].join(', ')} (a family the pack ships is named in its manifest)`,
				);
			} else font = wanted;
		} else if (font === undefined) errors.push('Missing token "font"');

		// The display and serif slots: a font that is neither bundled nor shipped by the pack
		// falls back to the style's default with a warning, so a pack made for a later app
		// version that bundles more fonts still loads.
		const slot = (name: 'font-display' | 'font-serif'): string | undefined => {
			const wanted = (input.tokens as Record<string, unknown>)[name];
			if (wanted === undefined) return options.fallback?.[name] ?? '';
			if (typeof wanted !== 'string') {
				errors.push(`Token "${name}" must be a font family name, or empty for the style's default`);
				return undefined;
			}
			if (wanted === '' || ([...BUNDLED_FONTS, ...own] as string[]).includes(wanted)) return wanted;
			warnings.push(
				`Token "${name}": the font "${wanted}" is neither bundled nor in the pack; the style's default is used`,
			);
			return '';
		};
		const fontDisplay = slot('font-display');
		const fontSerif = slot('font-serif');

		if (
			day &&
			night &&
			radius !== undefined &&
			font !== undefined &&
			fontDisplay !== undefined &&
			fontSerif !== undefined
		)
			tokens = { day, night, radius, font, 'font-display': fontDisplay, 'font-serif': fontSerif };
	}

	if (tokens && errors.length === 0) {
		// Without a default to inherit from, the pack set everything and all pairs count.
		errors.push(...contrastProblems(tokens, options.fallback ? explicit : undefined));
	}
	if (errors.length > 0 || !manifest.success || !tokens) return { ok: false, errors };
	const { style, ...rest } = manifest.data;
	if (style !== undefined && options.styles && !options.styles.includes(style)) {
		warnings.push(`Unknown style "${style}" is ignored`);
		return { ok: true, pack: { manifest: rest, tokens, fonts }, warnings };
	}
	return { ok: true, pack: { manifest: manifest.data, tokens, fonts }, warnings };
}

// -- Output --------------------------------------------------------------------------------------

const STACKS = {
	system: 'ui-sans-serif, system-ui, sans-serif',
	fallback: '"Figtree Variable", ui-sans-serif, system-ui, sans-serif',
	serif: 'ui-serif, serif',
};

/** The `font-family` name each bundled font has in `packages/ui/src/fonts.css`. */
const BUNDLED_FAMILY: Record<Exclude<BundledFont, 'system'>, string> = {
	Figtree: 'Figtree Variable',
	'Barlow Condensed': 'Barlow Condensed',
	'Instrument Serif': 'Instrument Serif',
	Archivo: 'Archivo Variable',
};

/** The CSS font stack for a font slot's value (never empty: empty slots are not emitted). */
function fontStack(font: string, slot: 'font' | 'font-display' | 'font-serif' = 'font'): string {
	if (font === 'system') return slot === 'font-serif' ? STACKS.serif : STACKS.system;
	const family = BUNDLED_FAMILY[font as keyof typeof BUNDLED_FAMILY] ?? font;
	if (slot === 'font' && family === BUNDLED_FAMILY.Figtree) return STACKS.fallback;
	return `"${family}", ${slot === 'font-serif' ? STACKS.serif : STACKS.fallback}`;
}

export interface StylesheetOptions {
	/**
	 * Write each color token's channels next to it (`--ink-r`, `-g`, `-b` 0 to 255, `-a` 0 to 1),
	 * which the app's mixes fall back to in browsers without `color-mix()`. The server asks for
	 * them while it supports such browsers.
	 */
	channels?: boolean;
}

/** A token's lines: the value, and its channels when asked for and the token is a color. */
function tokenLines(name: ModeToken, value: string, channels: boolean): string[] {
	const lines = [`\t${cssVariable(name)}: ${value};`];
	const color = channels && MODE_TOKENS[name].kind === 'color' ? parseColor(value) : null;
	if (color) {
		const c = colorChannels(color);
		for (const key of ['r', 'g', 'b', 'a'] as const) {
			lines.push(`\t${cssVariable(name)}-${key}: ${c[key]};`);
		}
	}
	return lines;
}

/**
 * The stylesheet for a pack: custom properties for the day palette (`:root`, `.day`) and the
 * night palette (`html.dark`). The selectors are one step more specific than the app's own
 * (`:root`, `.dark`), so the theme wins wherever its stylesheet sits, plus `@font-face` rules for the pack's own fonts. Built only from
 * validated, canonical values, so nothing a pack wrote reaches the browser as text.
 * `fontUrl` turns a font file name into the address it is served from.
 */
export function renderStylesheet(
	pack: ThemePack,
	fontUrl: (file: string) => string,
	options: StylesheetOptions = {},
): string {
	const { tokens } = pack;
	const block = (values: Record<ModeToken, string>) =>
		MODE_TOKEN_NAMES.flatMap((name) =>
			tokenLines(name, values[name], options.channels ?? false),
		).join('\n');
	// An empty display or serif slot is left out: the style's default applies (theme.css).
	const fonts = (['font', 'font-display', 'font-serif'] as const)
		.filter((slot) => tokens[slot] !== '')
		.map((slot) => `\t${cssVariable(slot)}: ${fontStack(tokens[slot], slot)};`)
		.join('\n');
	const faces: string[] = [];
	for (const [family, list] of Object.entries(pack.manifest.fonts ?? {})) {
		// The display face (clocks, countdowns) never flashes in a fallback: it blocks briefly.
		const display = family === tokens['font-display'] ? 'block' : 'swap';
		for (const face of list) {
			faces.push(
				`@font-face {\n\tfont-family: "${family}";\n\tsrc: url("${fontUrl(face.file)}") format("woff2");\n\tfont-weight: ${face.weight};\n\tfont-style: ${face.style};\n\tfont-display: ${display};\n}`,
			);
		}
	}
	return [
		`/* ${pack.manifest.id} ${pack.manifest.version} (generated from a validated theme pack) */`,
		...faces,
		`html:root,\nhtml .day {\n${block(tokens.day)}\n\t${cssVariable('radius')}: ${tokens.radius};\n${fonts}\n}`,
		`html.dark {\n${block(tokens.night)}\n}`,
		'',
	].join('\n');
}

/** The colors a theme card shows as swatches. */
export const PREVIEW_TOKENS = [
	'wall',
	'surface',
	'ink',
	'ink-soft',
	'attention',
	'now',
	'sun',
	'info',
	'heat',
] as const satisfies readonly ModeToken[];

export type ThemePreview = Record<'day' | 'night', Record<(typeof PREVIEW_TOKENS)[number], string>>;

export function previewOf(tokens: ThemeTokens): ThemePreview {
	const pick = (values: Record<ModeToken, string>) =>
		Object.fromEntries(PREVIEW_TOKENS.map((name) => [name, values[name]])) as ThemePreview['day'];
	return { day: pick(tokens.day), night: pick(tokens.night) };
}
