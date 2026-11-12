/**
 * Text size on this device: the root font size, so every size given in rem grows or shrinks
 * (`data-text-size` on <html>, sizes in theme.css). Kept in this browser only
 * (`famos.textSize`); app.html repeats `parseTextSize` for the first paint and must match it.
 */
export type TextSize = 'small' | 'normal' | 'large' | 'larger';

export const TEXT_SIZES: readonly TextSize[] = ['small', 'normal', 'large', 'larger'];

/** The choice kept in this browser, if it is one of the sizes (normal is never stored). */
export function parseTextSize(value: string | null): TextSize | null {
	return value === 'small' || value === 'large' || value === 'larger' ? value : null;
}
