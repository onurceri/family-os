export interface QuietTextInput {
	/** A family display: nobody there to wait for. */
	family: boolean;
	/** Nothing is on the calendar in the coming week either. */
	week: boolean;
	/** How many things wait for this person to decide (the header's count). */
	waiting: number;
}

/**
 * The key of the quiet day's sentence. Only a person with nothing to decide hears that nothing
 * waits for them; otherwise the line speaks of the calendar alone.
 */
export function quietTextKey({ family, week, waiting }: QuietTextInput): string {
	if (family) return week ? 'home_quiet_text_week_family' : 'home_quiet_text_family';
	if (waiting > 0) return week ? 'home_quiet_text_week_open' : 'home_quiet_text_open';
	return week ? 'home_quiet_text_week' : 'home_quiet_text';
}
