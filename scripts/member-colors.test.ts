import { describe, expect, it } from 'vitest';
import { MEMBER_COLORS } from '../packages/sdk/src/index.ts';
import { contrastRatio, parseColor } from '../packages/themes/src/color.ts';
import { onMemberColor } from '../packages/ui/src/famos/on-member-color.ts';

/** The day tokens that letters on a member color use (packages/ui/src/theme.css, `.day`). */
const TEXT = { 'var(--on-color)': '#ffffff', 'var(--ink)': '#1d1c1a' } as const;
const rgb = (hex: string) => {
	const c = parseColor(hex);
	if (!c) throw new Error(hex);
	return c;
};
const ratioOn = (color: string) => contrastRatio(rgb(TEXT[onMemberColor(color)]), rgb(color));

describe('member colors', () => {
	it('every palette color has readable initials (WCAG AA, 4.5:1)', () => {
		for (const color of MEMBER_COLORS) expect(ratioOn(color), color).toBeGreaterThanOrEqual(4.5);
	});

	it('any color an admin picks gets at least the better of white and ink', () => {
		for (let r = 0; r < 256; r += 17)
			for (let g = 0; g < 256; g += 17)
				for (let b = 0; b < 256; b += 51) {
					const color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
					const best = Math.max(
						...Object.values(TEXT).map((t) => contrastRatio(rgb(t), rgb(color))),
					);
					expect(ratioOn(color), color).toBeCloseTo(best, 1);
				}
	});
});
