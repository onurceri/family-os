export type RepeatUnit = 'none' | 'months' | 'years';

/** How many months or years "Every … months" starts at: more than one, as the wording implies. */
const STARTING_INTERVAL = { months: 3, years: 2 } as const;

/**
 * The form after the repeat choice changes. Switching a rule on starts at a few months or years
 * instead of every single one; an interval already chosen (a preset's, or a saved one) is kept.
 */
export function withRepeat<V extends { repeat: RepeatUnit; interval: number }>(
	v: V,
	repeat: RepeatUnit,
): V {
	const startsNow = v.repeat === 'none' && repeat !== 'none';
	return {
		...v,
		repeat,
		interval: startsNow && v.interval === 1 ? STARTING_INTERVAL[repeat] : v.interval,
	};
}
