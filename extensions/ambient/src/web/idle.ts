/**
 * Whether ambient mode covers the screen now: it may take over (`idle`, false on a screen that
 * has pages, where the photos are a page instead), nothing is covering it yet, no dialog or side
 * panel is open (the top layer would keep a dialog floating over the photos), and nobody has
 * touched the screen for the idle time.
 */
export function shouldCover(input: {
	idle: boolean;
	covering: boolean;
	overlayOpen: boolean;
	lastActivity: number;
	now: number;
	idleMinutes: number;
}): boolean {
	return (
		input.idle &&
		!input.covering &&
		!input.overlayOpen &&
		input.now - input.lastActivity >= input.idleMinutes * 60_000
	);
}

/**
 * The time the idle wait counts from. While a dialog or a side panel is open the person is still
 * there, so the wait starts again from now; once it closes, the whole idle time runs from then.
 */
export function idleSince(lastActivity: number, now: number, overlayOpen: boolean): number {
	return overlayOpen ? now : lastActivity;
}

/**
 * Whether there is something to cover the screen with. A display covers with the photos, the
 * weather or at least a calm clock, so seeing either is enough. A family device (`photosOnly`)
 * covers only with photos it may see and that exist, so a tablet in use never turns into a bare
 * clock. `photoCount` is null while the photos have not been read.
 */
export function hasCover(input: {
	photosOnly: boolean;
	canPhotos: boolean;
	canWeather: boolean;
	photoCount: number | null;
}): boolean {
	if (!input.photosOnly) return input.canPhotos || input.canWeather;
	return input.canPhotos && (input.photoCount ?? 0) > 0;
}

/** Input that counts as someone using the screen. */
export const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;
/**
 * Input that counts as use without ending the cover: the mouse wheel and a mouse moving. They
 * arrive many times a second, so one counts at most once per `USE_EVERY_MS`.
 */
export const USE_EVENTS = ['wheel', 'pointermove'] as const;
export const USE_EVERY_MS = 1000;

/** Whether a wheel or pointer-move event counts now, given when input last counted. */
export function countsAsUse(lastCounted: number, now: number): boolean {
	return now - lastCounted >= USE_EVERY_MS;
}

/** Everything a touch, a click or a key sends, so none of it reaches what is under the cover. */
export const COVER_EVENTS = [
	...ACTIVITY_EVENTS,
	'pointerup',
	'pointercancel',
	'mousedown',
	'mouseup',
	'touchend',
	'touchcancel',
	'click',
] as const;

const TOUCH_ENDS = new Set(['pointerup', 'pointercancel', 'touchend', 'touchcancel']);

/**
 * What an input event does while the cover is up: `pass` when nothing covers the screen (the app
 * gets it as usual); otherwise the cover keeps it from the app, and a key or the click that ends a
 * tap takes the cover away (`end`). The end of a touch takes it away shortly after (`endSoon`), in
 * case no click follows (a swipe); the start of one only `hold`s it, so the rest of the same tap
 * still lands on the cover and never on a control under it.
 */
export function coverInput(type: string, covering: boolean): 'pass' | 'hold' | 'end' | 'endSoon' {
	if (!covering) return 'pass';
	if (type === 'keydown' || type === 'click') return 'end';
	if (TOUCH_ENDS.has(type)) return 'endSoon';
	return 'hold';
}
