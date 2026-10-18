/**
 * Which of a family display's screens is showing: Today (index 0) or one of its pages
 * (1..count). A plain state machine with no timers: the display feeds it the time, so every rule
 * can be tested without waiting.
 */
export interface RotationConfig {
	/** How long Today stays before the first page. */
	todaySeconds: number;
	/** How long each page stays. */
	pageSeconds: number;
	/** After a touch, how long the screen holds before it goes back to Today. */
	backSeconds: number;
}

export interface RotationState {
	/** 0 is Today; 1..count are the pages. */
	index: number;
	/** When the current screen came up (ms). */
	since: number;
	/** While set, the screen holds until then, and goes back to Today after it (ms). */
	pausedUntil: number | null;
}

/** Today, shown from `now`. */
export const startRotation = (now: number): RotationState => ({
	index: 0,
	since: now,
	pausedUntil: null,
});

const stay = (index: number, config: RotationConfig): number =>
	(index === 0 ? config.todaySeconds : config.pageSeconds) * 1000;

/**
 * The state at `now`. The screen moves on when the current one has stayed its time, wrapping from
 * the last page back to Today. After a touch it holds until `pausedUntil`, then goes to Today.
 * With no pages it is always Today, and when the pages shrink below the screen showing (one lost
 * its permission) it goes to Today.
 */
export function tick(
	state: RotationState,
	now: number,
	config: RotationConfig,
	count: number,
): RotationState {
	if (count <= 0) {
		return state.index === 0 && state.pausedUntil === null ? state : startRotation(now);
	}
	if (state.index > count) return startRotation(now);
	if (state.pausedUntil !== null) {
		return now >= state.pausedUntil ? startRotation(now) : state;
	}
	if (now - state.since < stay(state.index, config)) return state;
	return { index: (state.index + 1) % (count + 1), since: now, pausedUntil: null };
}

/** A touch: hold the screen for `backSeconds` more. */
export function touch(state: RotationState, now: number, config: RotationConfig): RotationState {
	return { ...state, pausedUntil: now + config.backSeconds * 1000 };
}

/** Go to a screen (a swipe or a dot); that holds it too. */
export function goTo(index: number, now: number, config: RotationConfig): RotationState {
	return { index, since: now, pausedUntil: now + config.backSeconds * 1000 };
}

/** The next (`1`) or previous (`-1`) screen, wrapping round; that holds it too. */
export function step(
	state: RotationState,
	direction: 1 | -1,
	now: number,
	config: RotationConfig,
	count: number,
): RotationState {
	if (count <= 0) return state;
	const total = count + 1;
	return goTo((state.index + direction + total) % total, now, config);
}
