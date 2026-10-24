/** Temperatures and percentages as the family's region format writes them. */

/** A whole number in the family's region format (digits, minus sign). */
export function formatWhole(value: number, formatLocale: string): string {
	// `|| 0` keeps a rounded -0.4 from showing as "-0".
	return new Intl.NumberFormat(formatLocale, { maximumFractionDigits: 0 }).format(
		Math.round(value) || 0,
	);
}

/** A temperature in the family's region format, with its unit letter when the unit is given. */
export function formatDegrees(
	value: number,
	formatLocale: string,
	unit?: 'celsius' | 'fahrenheit',
): string {
	const letter = unit === undefined ? '' : unit === 'fahrenheit' ? 'F' : 'C';
	return `${formatWhole(value, formatLocale)}°${letter}`;
}
