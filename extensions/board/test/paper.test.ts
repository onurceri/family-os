import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fastenerOf, isShortNote, PIN_COLORS, tiltOf } from '../src/web/paper.ts';

const ids = Array.from(
	{ length: 300 },
	(_, i) => `board_note_0190${i.toString(16).padStart(8, '0')}`,
);

describe('tiltOf', () => {
	it('is fixed per note and stays between −2° and 2°', () => {
		for (const id of ids) {
			const tilt = tiltOf(id);
			expect(tilt).toBe(tiltOf(id));
			expect(tilt).toBeGreaterThanOrEqual(-2);
			expect(tilt).toBeLessThanOrEqual(2);
		}
	});

	it('leans both ways across a board', () => {
		const tilts = ids.map(tiltOf);
		expect(tilts.some((t) => t < -1)).toBe(true);
		expect(tilts.some((t) => t > 1)).toBe(true);
	});
});

describe('fastenerOf', () => {
	it('is fixed per note', () => {
		for (const id of ids) {
			expect(fastenerOf({ id, pinned: false })).toEqual(fastenerOf({ id, pinned: false }));
		}
	});

	it('gives a pinned note an accent push pin', () => {
		for (const id of ids) {
			expect(fastenerOf({ id, pinned: true })).toEqual({ kind: 'pin', color: 'accent' });
		}
	});

	it('mixes tape and push pins of every colour, never accent, for the other notes', () => {
		const chosen = ids.map((id) => fastenerOf({ id, pinned: false }));
		expect(chosen.some((f) => f.kind === 'tape')).toBe(true);
		for (const color of PIN_COLORS) {
			expect(chosen.some((f) => f.kind === 'pin' && f.color === color)).toBe(true);
		}
		expect(chosen.some((f) => f.kind === 'pin' && f.color === 'accent')).toBe(false);
	});

	it('never gives an ordinary note a pin that looks like the pinned one in the default theme', () => {
		const tokens = JSON.parse(
			readFileSync(new URL('../../../themes/ev-isigi/tokens.json', import.meta.url), 'utf8'),
		) as Record<'day' | 'night', Record<string, string>>;
		const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
		const distance = (a: string, b: string) =>
			Math.hypot(...rgb(a).map((v, i) => v - (rgb(b)[i] ?? 0)));
		for (const mode of ['day', 'night'] as const) {
			const accent = tokens[mode].accent ?? '';
			for (const color of PIN_COLORS) {
				expect(distance(tokens[mode][color] ?? accent, accent)).toBeGreaterThan(100);
			}
		}
	});
});

describe('isShortNote', () => {
	it('writes a note of up to 40 characters large', () => {
		expect(isShortNote({ text: 'Bins out tonight', hasPhoto: false })).toBe(true);
		expect(isShortNote({ text: 'x'.repeat(40), hasPhoto: false })).toBe(true);
		expect(isShortNote({ text: `  ${'x'.repeat(40)}\n`, hasPhoto: false })).toBe(true);
	});

	it('keeps longer notes and photo notes at the body size', () => {
		expect(isShortNote({ text: 'x'.repeat(41), hasPhoto: false })).toBe(false);
		expect(isShortNote({ text: 'Look!', hasPhoto: true })).toBe(false);
	});
});
