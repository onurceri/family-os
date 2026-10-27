import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	CONTRAST_RULES,
	colorChannels,
	contrastRatio,
	MAX_FONT_BYTES,
	MODE_TOKEN_NAMES,
	MODE_TOKENS,
	parseColor,
	parseRadius,
	parseShadow,
	previewOf,
	type RawThemePack,
	renderStylesheet,
	SHARED_TOKENS,
	serializeColor,
	validateThemePack,
} from '../src/index.ts';
import { readThemeDirSync } from '../src/node.ts';

const root = join(import.meta.dirname, '../../..');
const bundled = (id: string) => readThemeDirSync(join(root, 'themes', id));

/** A tiny but WOFF2-looking file (signature plus padding): enough for the format check. */
const fakeWoff2 = () => {
	const bytes = new Uint8Array(64);
	bytes.set([0x77, 0x4f, 0x46, 0x32]);
	return Buffer.from(bytes).toString('base64');
};

const defaults = () => {
	const result = validateThemePack(bundled('ev-isigi'));
	if (!result.ok) throw new Error(result.errors.join('; '));
	return result.pack.tokens;
};

/** A valid small pack (inherits what it leaves out from Ev Işığı) to break in different ways. */
const pack = (
	change: (p: {
		manifest: Record<string, unknown>;
		tokens: Record<string, unknown>;
	}) => void = () => {},
): RawThemePack => {
	const base = {
		manifest: { id: 'test-pack', name: 'Test', version: '1.0.0', famos: '>=0.1.0' } as Record<
			string,
			unknown
		>,
		tokens: {
			day: {
				wall: '#ffffff',
				surface: '#ffffff',
				idle: '#eeeeee',
				ink: '#000000',
				'ink-soft': '#333333',
			},
			night: {
				wall: '#000000',
				surface: '#111111',
				idle: '#222222',
				ink: '#ffffff',
				'ink-soft': '#dddddd',
			},
		} as Record<string, unknown>,
	};
	change(base);
	return base;
};

const check = (p: RawThemePack) =>
	validateThemePack(p, { fallback: defaults(), appVersion: '0.1.0' });
const errorsOf = (p: RawThemePack) => {
	const result = check(p);
	return result.ok ? [] : result.errors;
};

describe('colors', () => {
	it('parses hex, rgb() and oklch() and writes one canonical form', () => {
		expect(serializeColor(parseColor('#FFF') as never)).toBe('#ffffff');
		expect(serializeColor(parseColor('#1d1c1a') as never)).toBe('#1d1c1a');
		expect(serializeColor(parseColor('rgb(29, 28, 26)') as never)).toBe('#1d1c1a');
		expect(serializeColor(parseColor('rgb(0 0 0 / 70%)') as never)).toBe('rgb(0 0 0 / 0.7)');
		expect(serializeColor(parseColor('rgba(0,0,0,.5)') as never)).toBe('rgb(0 0 0 / 0.5)');
		expect(serializeColor(parseColor('oklch(1 0 0)') as never)).toBe('#ffffff');
		expect(serializeColor(parseColor('oklch(0 0 0)') as never)).toBe('#000000');
		// sRGB red in OKLCH.
		expect(serializeColor(parseColor('oklch(62.8% 0.2577 29.23deg)') as never)).toBe('#ff0000');
	});

	it('refuses everything else', () => {
		for (const bad of [
			'red',
			'hsl(0 0% 0%)',
			'#12',
			'rgb(1 2)',
			'rgb(1 2 3 4 5)',
			'url(x)',
			'oklch(a b c)',
			'#ggg',
			'',
		]) {
			expect(parseColor(bad), bad).toBeNull();
		}
	});

	it('computes WCAG contrast', () => {
		const black = parseColor('#000') as never;
		const white = parseColor('#fff') as never;
		expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
		expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
		// A known pair: #767676 on white is the classic 4.54:1.
		expect(contrastRatio(parseColor('#767676') as never, white)).toBeCloseTo(4.54, 2);
	});
});

describe('value grammars', () => {
	it('checks radius and shadow values', () => {
		expect(parseRadius('0.75rem')).toBe('0.75rem');
		expect(parseRadius('12px')).toBe('12px');
		expect(parseRadius('3rem')).toBeNull();
		expect(parseRadius('-1px')).toBeNull();
		expect(parseRadius('calc(1px)')).toBeNull();
		expect(parseShadow('0 1px 2px rgb(30 25 15 / 0.08)')).toBe('0 1px 2px rgb(30 25 15 / 0.08)');
		expect(parseShadow('inset 0 0 0 1px #fff, 0 4px 12px rgb(0 0 0 / 0.2)')).toBe(
			'inset 0 0 0 1px #ffffff, 0 4px 12px rgb(0 0 0 / 0.2)',
		);
		expect(parseShadow('none')).toBe('none');
		expect(parseShadow('0 1px 2px red')).toBeNull();
		expect(parseShadow('0 1px 2px #000; color: red')).toBeNull();
		expect(
			parseShadow('0 1px 2px #000, 0 1px 2px #000, 0 1px 2px #000, 0 1px 2px #000, 0 1px 2px #000'),
		).toBeNull();
		expect(parseShadow('0 500px 2px #000')).toBeNull();
		expect(parseShadow('0 1px -2px #000')).toBeNull();
	});
});

describe('the bundled packs', () => {
	it('every bundled pack passes the contrast check strictly, with no warnings', () => {
		for (const id of ['ev-isigi', 'coast', 'forest', 'high-contrast', 'paper', 'plum']) {
			const result = validateThemePack(bundled(id), { appVersion: '0.1.0', fallback: defaults() });
			expect(result.ok, `${id}: ${JSON.stringify(result)}`).toBe(true);
			if (result.ok) expect(result.warnings, id).toEqual([]);
		}
	});

	it('Ev Işığı is complete and loads', () => {
		const result = validateThemePack(bundled('ev-isigi'), { appVersion: '0.1.0' });
		expect(result.ok).toBe(true);
		if (result.ok) {
			for (const name of MODE_TOKEN_NAMES) {
				expect(result.pack.tokens.day[name], `day ${name}`).toBeTruthy();
				expect(result.pack.tokens.night[name], `night ${name}`).toBeTruthy();
			}
			expect(result.pack.tokens.font).toBe('Figtree');
			// The display and serif slots are empty: the style's defaults apply.
			expect(result.pack.tokens['font-display']).toBe('');
			expect(result.pack.tokens['font-serif']).toBe('');
		}
	});

	it('High contrast passes AAA for every contrast pair, in both palettes', () => {
		const raw = bundled('high-contrast');
		const result = validateThemePack(raw, { appVersion: '0.1.0', fallback: defaults() });
		expect(result.ok, JSON.stringify(result)).toBe(true);
		if (!result.ok) return;
		for (const mode of ['day', 'night'] as const) {
			for (const rule of CONTRAST_RULES) {
				const ratio = contrastRatio(
					parseColor(result.pack.tokens[mode][rule.foreground]) as never,
					parseColor(result.pack.tokens[mode][rule.background]) as never,
				);
				expect(ratio, `${mode} ${rule.foreground} on ${rule.background}`).toBeGreaterThanOrEqual(7);
			}
			// State colors stay readable as markers on the wall and cards, and distinct from each other.
			const states = ['attention', 'now', 'sun', 'info', 'heat'] as const;
			for (const state of states) {
				for (const ground of ['wall', 'surface'] as const) {
					const ratio = contrastRatio(
						parseColor(result.pack.tokens[mode][state]) as never,
						parseColor(result.pack.tokens[mode][ground]) as never,
					);
					expect(ratio, `${mode} ${state} on ${ground}`).toBeGreaterThanOrEqual(4.5);
				}
			}
			const colors = states.map((s) => result.pack.tokens[mode][s]);
			expect(new Set(colors).size).toBe(states.length);
		}
	});

	it('has a preview of both palettes', () => {
		const result = validateThemePack(bundled('high-contrast'), { fallback: defaults() });
		if (!result.ok) throw new Error('invalid');
		const preview = previewOf(result.pack.tokens);
		expect(preview.day.wall).toBe('#f2f2f2');
		expect(preview.night.wall).toBe('#000000');
	});
});

describe('validation', () => {
	it('accepts a small pack and fills what it leaves out from the default', () => {
		const result = check(pack());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.pack.tokens.day.wall).toBe('#ffffff');
			expect(result.pack.tokens.day.attention).toBe(defaults().day.attention);
			expect(result.pack.tokens.radius).toBe('0.75rem');
		}
	});

	it('without a default to fall back to, every token is required', () => {
		const result = validateThemePack(pack(), { appVersion: '0.1.0' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors).toContain('Missing token "attention" in day');
	});

	it('ignores unknown tokens and reports them', () => {
		const result = check(
			pack((p) => {
				(p.tokens.day as Record<string, string>).sparkle = '#ff00ff';
				p.tokens.extra = 'x';
			}),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toContain('Unknown token "sparkle" in day is ignored');
			expect(result.warnings).toContain('Unknown token "extra" is ignored');
		}
	});

	it('keeps a preferred style the app knows, and drops an unknown one with a warning', () => {
		const styles = ['broadsheet', 'lanes', 'wall'];
		const known = validateThemePack(
			pack((p) => {
				p.manifest.style = 'wall';
			}),
			{ fallback: defaults(), styles },
		);
		expect(known.ok && known.pack.manifest.style).toBe('wall');
		if (known.ok) expect(known.warnings).toEqual([]);
		const unknown = validateThemePack(
			pack((p) => {
				p.manifest.style = 'mosaic';
			}),
			{ fallback: defaults(), styles },
		);
		expect(unknown.ok).toBe(true);
		if (unknown.ok) {
			expect(unknown.pack.manifest.style).toBeUndefined();
			expect(unknown.warnings).toContain('Unknown style "mosaic" is ignored');
		}
		const malformed = check(
			pack((p) => {
				p.manifest.style = 'Not An Id';
			}),
		);
		expect(malformed.ok).toBe(false);
	});

	it('has board and note tokens, with rules for text on the board and on every paper', () => {
		for (const name of ['board', 'board-grain', 'note-ink', 'note-ink-soft', 'note-tape']) {
			expect(MODE_TOKEN_NAMES).toContain(name);
		}
		for (let i = 1; i <= 5; i++) expect(MODE_TOKEN_NAMES).toContain(`note-${i}`);
		const pairs = CONTRAST_RULES.map((r) => `${r.foreground}/${r.background}/${r.min}`);
		for (const text of ['ink', 'ink-soft']) expect(pairs).toContain(`${text}/board/4.5`);
		for (const text of ['note-ink', 'note-ink-soft'])
			for (let i = 1; i <= 5; i++) expect(pairs).toContain(`${text}/note-${i}/4.5`);
	});

	it('refuses notes whose text is unreadable on a paper or the board text on a board', () => {
		const paperErrors = errorsOf(
			pack((p) => {
				(p.tokens.day as Record<string, string>)['note-3'] = '#222222';
			}),
		);
		expect(paperErrors.some((e) => e.startsWith('Contrast: note-ink on note-3 (day)'))).toBe(true);
		const boardErrors = errorsOf(
			pack((p) => {
				(p.tokens.night as Record<string, string>).board = '#808080';
			}),
		);
		expect(boardErrors.some((e) => e.startsWith('Contrast: ink on board (night)'))).toBe(true);
	});

	it('lets the texture and the tape be transparent, and the papers not', () => {
		expect(
			check(
				pack((p) => {
					const day = p.tokens.day as Record<string, string>;
					day['board-grain'] = 'rgb(0 0 0 / 0.1)';
					day['note-tape'] = 'rgb(255 255 255 / 0.5)';
				}),
			).ok,
		).toBe(true);
		const opaque = errorsOf(
			pack((p) => {
				(p.tokens.day as Record<string, string>)['note-1'] = 'rgb(255 255 255 / 0.5)';
			}),
		);
		expect(opaque).toContain('Token "note-1" in day must be opaque');
	});

	it('refuses a pack that fails contrast and lists every failing pair', () => {
		const errors = errorsOf(
			pack((p) => {
				const day = p.tokens.day as Record<string, string>;
				day['ink-soft'] = '#dddddd';
				day.ink = '#cccccc';
			}),
		);
		expect(errors).toContain('Contrast: ink on wall (day) is 1.6:1, needs 4.5:1');
		expect(errors.filter((e) => e.startsWith('Contrast: ink-soft'))).toHaveLength(4);
		expect(errors.some((e) => e.includes('(night)'))).toBe(false);
	});

	it('checks on-color against the state colors it sits on, at 4.5:1', () => {
		const errors = errorsOf(
			pack((p) => ((p.tokens.night as Record<string, string>)['on-color'] = '#ffffff')),
		);
		expect(errors.some((e) => e.startsWith('Contrast: on-color on attention (night)'))).toBe(true);
		// sun and heat are only icon colors: nothing writes on them, so they have no rule.
		expect(errors.some((e) => e.includes('on sun') || e.includes('on heat'))).toBe(false);
	});

	it('checks on-accent on accent (the next-up hero) at 4.5:1, in both palettes', () => {
		const pairs = CONTRAST_RULES.map((r) => `${r.foreground}/${r.background}/${r.min}`);
		expect(pairs).toContain('on-accent/accent/4.5');
		// accent is never text, so it has no rule against the wall or cards.
		expect(CONTRAST_RULES.some((r) => r.foreground === 'accent')).toBe(false);
		const errors = errorsOf(
			pack((p) => {
				(p.tokens.day as Record<string, string>).accent = '#888888';
				(p.tokens.day as Record<string, string>)['on-accent'] = '#ffffff';
			}),
		);
		expect(errors).toContain('Contrast: on-accent on accent (day) is 3.5:1, needs 4.5:1');
		const night = errorsOf(
			pack((p) => ((p.tokens.night as Record<string, string>).accent = '#26272a')),
		);
		expect(night.some((e) => e.startsWith('Contrast: on-accent on accent (night)'))).toBe(true);
		// A pack that wants no accent sets it to its ink, with its wall on it.
		expect(
			check(
				pack((p) => {
					Object.assign(p.tokens.day as object, { accent: '#000000', 'on-accent': '#ffffff' });
					Object.assign(p.tokens.night as object, { accent: '#ffffff', 'on-accent': '#000000' });
				}),
			).ok,
		).toBe(true);
	});

	it('takes the display and serif fonts from the bundled ones or the pack, and falls back with a warning', () => {
		const ok = check(
			pack((p) => {
				p.tokens['font-display'] = 'Archivo';
				p.tokens['font-serif'] = 'Instrument Serif';
			}),
		);
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.pack.tokens['font-display']).toBe('Archivo');
			expect(ok.pack.tokens['font-serif']).toBe('Instrument Serif');
			expect(ok.warnings).toEqual([]);
		}
		// Left out: the style's default (empty), inherited from Ev Işığı.
		const inherited = check(pack());
		if (inherited.ok) expect(inherited.pack.tokens['font-display']).toBe('');
		// A font nobody ships: the style's default, and the pack still loads.
		const unknown = check(pack((p) => (p.tokens['font-display'] = 'Comic Sans')));
		expect(unknown.ok).toBe(true);
		if (unknown.ok) {
			expect(unknown.pack.tokens['font-display']).toBe('');
			expect(unknown.warnings).toContain(
				'Token "font-display": the font "Comic Sans" is neither bundled nor in the pack; the style\'s default is used',
			);
		}
		expect(errorsOf(pack((p) => (p.tokens['font-serif'] = 12)))).toContain(
			'Token "font-serif" must be a font family name, or empty for the style\'s default',
		);
		// The condensed and serif faces are not body fonts.
		expect(
			errorsOf(pack((p) => (p.tokens.font = 'Barlow Condensed'))).some((e) =>
				e.startsWith('Token "font" must be one of: Figtree, Archivo, system'),
			),
		).toBe(true);
		expect(check(pack((p) => (p.tokens.font = 'Archivo'))).ok).toBe(true);
	});

	it('checks state colors written as text on the wall and cards', () => {
		const errors = errorsOf(
			pack((p) => ((p.tokens.day as Record<string, string>).attention = '#ff9988')),
		);
		expect(errors.some((e) => e.startsWith('Contrast: attention on wall (day)'))).toBe(true);
	});

	it('refuses a failing pack always (there is no lenient mode)', () => {
		const result = check(pack((p) => ((p.tokens.day as Record<string, string>).ink = '#cccccc')));
		expect(result.ok).toBe(false);
	});

	it('refuses colors that do not parse, opaque tokens with transparency, bad radius, shadow and font', () => {
		const errors = errorsOf(
			pack((p) => {
				const day = p.tokens.day as Record<string, string>;
				day.line = 'red';
				day.idle = 'rgb(0 0 0 / 0.5)';
				day['shadow-lit'] = '0 1px 2px url(x)';
				p.tokens.radius = '5rem';
				p.tokens.font = 'Comic Sans';
			}),
		);
		expect(errors.some((e) => e.startsWith('Token "line" in day is not a color'))).toBe(true);
		expect(errors).toContain('Token "idle" in day must be opaque');
		expect(
			errors.some((e) => e.startsWith('Token "shadow-lit" in day is not a valid shadow')),
		).toBe(true);
		expect(errors.some((e) => e.startsWith('Token "radius" must be a length'))).toBe(true);
		expect(errors.some((e) => e.startsWith('Token "font" must be one of'))).toBe(true);
	});

	it('refuses a bad manifest and an incompatible app version', () => {
		expect(errorsOf(pack((p) => (p.manifest.id = '../evil')))[0]).toContain('Invalid manifest (id');
		expect(errorsOf(pack((p) => (p.manifest.famos = '>=9.0.0')))).toContain(
			'The pack is made for FamilyOS >=9.0.0, this is 0.1.0',
		);
		expect(validateThemePack('nope').ok).toBe(false);
	});

	it('accepts fonts only as WOFF2 files named in the manifest, within the size caps', () => {
		const withFont = (change: (r: RawThemePack) => void = () => {}) => {
			const raw = pack((p) => {
				p.manifest.fonts = { 'Test Sans': [{ file: 'test.woff2', weight: '100 900' }] };
				p.tokens.font = 'Test Sans';
			});
			raw.fonts = { 'test.woff2': fakeWoff2() };
			change(raw);
			return raw;
		};
		const ok = check(withFont());
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.pack.fonts['test.woff2']).toBeInstanceOf(Uint8Array);

		const errors = (r: RawThemePack) => {
			const result = check(r);
			return result.ok ? [] : result.errors;
		};
		expect(
			errors(
				withFont(
					(r) =>
						(r.fonts = {
							'test.woff2': Buffer.from('not a font at all, really, no way').toString('base64'),
						}),
				),
			),
		).toContain('Font file "test.woff2" is not a WOFF2 font');
		expect(errors(withFont((r) => (r.fonts = { 'test.ttf': fakeWoff2() })))).toContain(
			'Font file "test.ttf": only .woff2 files with a plain name are allowed',
		);
		expect(errors(withFont((r) => (r.fonts = { '../x.woff2': fakeWoff2() })))[0]).toContain(
			'plain name',
		);
		expect(errors(withFont((r) => (r.fonts = {})))).toContain(
			'Font "Test Sans" names test.woff2, which is not in the pack',
		);
		expect(errors(withFont((r) => (r.fonts = { 'test.woff2': '***' })))).toContain(
			'Font file "test.woff2" is not valid base64',
		);
		const big = Buffer.alloc(MAX_FONT_BYTES + 1);
		big.set([0x77, 0x4f, 0x46, 0x32]);
		expect(
			errors(withFont((r) => (r.fonts = { 'test.woff2': big.toString('base64') }))).some((e) =>
				e.includes('larger than'),
			),
		).toBe(true);
		expect(
			errors(
				withFont(
					(r) =>
						((r.manifest as Record<string, unknown>).fonts = { Figtree: [{ file: 'test.woff2' }] }),
				),
			),
		).toContain('The font name "Figtree" is reserved');
	});

	it('refuses a pack over the size limit', () => {
		const raw = pack();
		raw.fonts = { 'a.woff2': 'A'.repeat(2 * 1024 * 1024) };
		const result = check(raw);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]).toContain('larger than');
	});
});

describe('the stylesheet', () => {
	it('is generated from validated values only', () => {
		const withFont = pack((p) => {
			p.manifest.fonts = { 'Test Sans': [{ file: 'test.woff2', weight: '400' }] };
			p.tokens.font = 'Test Sans';
			p.manifest.name = '</style><script>alert(1)</script>';
			(p.tokens.day as Record<string, string>).sparkle = '#fff;} body{display:none';
		});
		withFont.fonts = { 'test.woff2': fakeWoff2() };
		const valid = check(withFont);
		if (!valid.ok) throw new Error(valid.errors.join('; '));
		const css = renderStylesheet(valid.pack, (file) => `/fonts/${file}`);
		expect(css).toContain('html:root,\nhtml .day {');
		expect(css).toContain('html.dark {');
		expect(css).toContain('--wall: #ffffff;');
		expect(css).toContain('--wall: #000000;');
		expect(css).toContain('--radius: 0.75rem;');
		expect(css).toContain('--font-family: "Test Sans", "Figtree Variable"');
		expect(css).toContain('src: url("/fonts/test.woff2") format("woff2")');
		expect(css).not.toContain('script');
		expect(css).not.toContain('display:none');
		expect(css).not.toContain('sparkle');
		// Every token is there, in both palettes.
		for (const name of MODE_TOKEN_NAMES) expect(css.split(`--${name}:`).length - 1).toBe(2);
		// Empty display and serif slots are left to the style.
		expect(css).not.toContain('--font-family-display');
		expect(css).not.toContain('--font-family-serif');
		expect(css).toContain('font-display: swap;');
		// No color channels unless asked for.
		expect(css).not.toContain('--wall-r');
	});

	it("writes each color token's channels when asked, equal to the color in both palettes", () => {
		const valid = check(bundled('ev-isigi'));
		if (!valid.ok) throw new Error(valid.errors.join('; '));
		const css = renderStylesheet(valid.pack, (file) => `/fonts/${file}`, { channels: true });
		const blocks = css.split('html.dark {');
		for (const [i, values] of [valid.pack.tokens.day, valid.pack.tokens.night].entries()) {
			const block = blocks[i] as string;
			for (const name of MODE_TOKEN_NAMES) {
				const color = MODE_TOKENS[name].kind === 'color' ? parseColor(values[name]) : null;
				if (!color) {
					expect(block).not.toContain(`--${name}-r:`);
					continue;
				}
				const c = colorChannels(color);
				const line = (key: string, value: number) => `--${name}-${key}: ${value};`;
				expect(block).toContain(`--${name}: ${values[name]};\n\t${line('r', c.r)}`);
				expect(block).toContain(line('g', c.g));
				expect(block).toContain(line('b', c.b));
				expect(block).toContain(line('a', c.a));
				expect(serializeColor(c)).toBe(serializeColor(color));
			}
		}
	});

	it('sets the display and serif slots a pack names, and blocks on its own display face', () => {
		const raw = pack((p) => {
			p.manifest.fonts = { 'Test Mono': [{ file: 'test.woff2', weight: '400' }] };
			p.tokens['font-display'] = 'Test Mono';
			p.tokens['font-serif'] = 'Instrument Serif';
			p.tokens.font = 'Archivo';
		});
		raw.fonts = { 'test.woff2': fakeWoff2() };
		const valid = check(raw);
		if (!valid.ok) throw new Error(valid.errors.join('; '));
		const css = renderStylesheet(valid.pack, (file) => `/fonts/${file}`);
		expect(css).toContain('--font-family: "Archivo Variable", "Figtree Variable"');
		expect(css).toContain('--font-family-display: "Test Mono", "Figtree Variable"');
		expect(css).toContain('--font-family-serif: "Instrument Serif", ui-serif, serif;');
		expect(css).toContain('font-display: block;');
		expect(css).not.toContain('font-display: swap;');
	});
});

describe('the token contract stays in one place', () => {
	it('the guide names every token', () => {
		const guide = readFileSync(join(root, 'docs/guide/appearance.md'), 'utf8');
		for (const name of [...MODE_TOKEN_NAMES, ...Object.keys(SHARED_TOKENS)]) {
			expect(guide, name).toContain(`| \`${name}\` |`);
		}
	});

	const css = readFileSync(join(root, 'packages/ui/src/theme.css'), 'utf8');
	const block = (selector: string) => {
		const start = css.indexOf(selector);
		return css.slice(start, css.indexOf('\n}', start));
	};
	const value = (blockText: string, token: string) =>
		new RegExp(`^\\s*--${token}:\\s*([^;]+);`, 'm').exec(blockText)?.[1]?.trim();
	const ev = () => {
		const result = validateThemePack(bundled('ev-isigi'));
		if (!result.ok) throw new Error('invalid');
		return result.pack.tokens;
	};

	it('theme.css equals the bundled Ev Işığı pack, token by token', () => {
		const day = block(':root,\n.day {');
		const night = block('.dark {');
		for (const name of MODE_TOKEN_NAMES) {
			const info = MODE_TOKENS[name];
			const canonical = (text: string | undefined) =>
				info.kind === 'shadow'
					? parseShadow(text)
					: serializeColor(parseColor(text ?? '') as never);
			expect(canonical(value(day, name)), `day ${name}`).toBe(ev().day[name]);
			// The night block only restates what differs from the day palette.
			expect(canonical(value(night, name) ?? value(day, name)), `night ${name}`).toBe(
				ev().night[name],
			);
		}
		expect(parseRadius(value(day, 'radius'))).toBe(ev().radius);
	});

	it('every token the stylesheet sets exists in theme.css (so a pack can only restyle what is used)', () => {
		for (const name of MODE_TOKEN_NAMES) expect(value(css, name), name).toBeTruthy();
		// The font slots: the body is set; display and serif fall back to the style, then the body.
		expect(value(css, 'font-family')).toContain('"Figtree Variable"');
		expect(css).toContain(
			'--font-display: var(--font-family-display, var(--style-font-display, var(--font-family)));',
		);
		expect(css).toContain(
			'--font-serif: var(--font-family-serif, var(--style-font-serif, var(--font-family)));',
		);
		expect(css).toContain('--color-on-accent: var(--on-accent);');
	});

	it('bundles the display and serif fonts, latin and latin-ext only, the display faces blocking', () => {
		const fonts = readFileSync(join(root, 'packages/ui/src/fonts.css'), 'utf8');
		expect(css).toContain('@import "./fonts.css";');
		const faces = fonts.split('@font-face').slice(1);
		const files = faces.map((f) => /files\/([a-z-]+?)-(latin(?:-ext)?)-/.exec(f)?.slice(1) ?? []);
		expect(new Set(files.map(([, subset]) => subset))).toEqual(new Set(['latin', 'latin-ext']));
		expect(new Set(files.map(([family]) => family))).toEqual(
			new Set(['barlow-condensed', 'instrument-serif', 'archivo']),
		);
		for (const face of faces) {
			expect(face).toContain('unicode-range');
			const display = /font-family: "(Barlow Condensed|Archivo Variable)"/.test(face);
			expect(face).toContain(`font-display: ${display ? 'block' : 'swap'};`);
		}
	});
});
