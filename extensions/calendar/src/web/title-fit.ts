/** The width in px of `text` drawn in a CSS `font` shorthand. */
export type MeasureText = (text: string, font: string) => number;

/**
 * A measure backed by a canvas, or null where there is none (a server, a test): without it a
 * block does not know whether its title wraps and keeps the time line.
 */
export function canvasMeasure(): MeasureText | null {
	if (typeof document === 'undefined') return null;
	const context = document.createElement('canvas').getContext('2d');
	if (!context) return null;
	return (text, font) => {
		context.font = font;
		return context.measureText(text).width;
	};
}

/**
 * Whether a title is wider than the room for it. A title's width does not depend on the column,
 * so it is measured once per title and font and compared to each width asked about.
 */
export function titleFitter(measure: MeasureText) {
	const widths = new Map<string, number>();
	return (title: string, font: string, room: number): boolean => {
		const key = `${font}|${title}`;
		let width = widths.get(key);
		if (width === undefined) {
			width = measure(title, font);
			widths.set(key, width);
		}
		return width > room;
	};
}
