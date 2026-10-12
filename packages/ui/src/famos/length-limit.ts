/** How many characters before the limit the counter starts to show. */
export const COUNTER_WINDOW = 20;

export interface LengthState {
	length: number;
	max: number;
	/** Past the limit: the text must not be saved. */
	over: boolean;
	/** Close to or past the limit: show the counter. */
	counting: boolean;
}

/**
 * Where a text stands against a limit. The length is that of the trimmed text, because that is
 * what is saved; the counter shows from the last `COUNTER_WINDOW` characters on.
 */
export function lengthState(text: string, max: number): LengthState {
	const length = text.trim().length;
	return { length, max, over: length > max, counting: length >= max - COUNTER_WINDOW };
}

/** "148/160", the same in every language. */
export const counterText = (state: LengthState): string => `${state.length}/${state.max}`;
