/**
 * Day and night: each device chooses to follow the system, the time of day, or to stay in the
 * day or the night palette of the active theme. Night is the `.dark` class on <html>.
 * The choice lives in this browser only (`famos.mode`); app.html applies it before first paint.
 * Without a choice, family displays follow the time of day and every other device the system.
 */
import { defaultMode, isNight, type Mode, parseMode } from './day-night.js';
import { family } from './family.svelte.js';

export type { Mode } from './day-night.js';

const KEY = 'famos.mode';
const MINUTE_MS = 60_000;

function stored(): Mode | null {
	try {
		return parseMode(localStorage.getItem(KEY));
	} catch {
		return null;
	}
}

class DayNight {
	/** What this device's person chose, or null for "like the system". */
	choice = $state<Mode | null>(typeof localStorage === 'undefined' ? null : stored());

	/** The mode shown in settings. */
	get mode(): Mode {
		return this.choice ?? 'system';
	}

	set(mode: Mode): void {
		this.choice = mode === 'system' ? null : mode;
		try {
			if (mode === 'system') localStorage.removeItem(KEY);
			else localStorage.setItem(KEY, mode);
		} catch {
			// private mode: the choice lasts until the page is closed
		}
	}
}

export const dayNight = new DayNight();

/**
 * Keeps `.dark` on <html> in line with the device's choice, the OS setting for "system" and the
 * clock in the family's time zone for "time of day" (checked every minute and when the page is
 * shown again, so a wall frame switches by itself).
 */
export function followDayNight(display = false): () => void {
	const query = matchMedia('(prefers-color-scheme: dark)');
	const mode = dayNight.choice ?? defaultMode(display);
	const apply = () => {
		const night = isNight(mode, Date.now(), family.timeZone, query.matches);
		document.documentElement.classList.toggle('dark', night);
	};
	apply();
	query.addEventListener('change', apply);
	const onVisible = () => {
		if (document.visibilityState === 'visible') apply();
	};
	document.addEventListener('visibilitychange', onVisible);
	const timer = mode === 'time' ? setInterval(apply, MINUTE_MS) : undefined;
	return () => {
		query.removeEventListener('change', apply);
		document.removeEventListener('visibilitychange', onVisible);
		clearInterval(timer);
	};
}

/**
 * Text size on this device: the root font size, so every size given in rem grows or shrinks
 * (`data-text-size` on <html>, sizes in theme.css). Kept in this browser only
 * (`famos.textSize`); app.html applies it before first paint.
 */
export const TEXT_SIZES = ['small', 'normal', 'large', 'larger'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
const TEXT_KEY = 'famos.textSize';

function storedTextSize(): TextSize {
	try {
		const value = localStorage.getItem(TEXT_KEY);
		return (TEXT_SIZES as readonly string[]).includes(value ?? '') ? (value as TextSize) : 'normal';
	} catch {
		return 'normal';
	}
}

class TextSizeChoice {
	size = $state<TextSize>(typeof localStorage === 'undefined' ? 'normal' : storedTextSize());

	set(size: TextSize): void {
		this.size = size;
		try {
			if (size === 'normal') localStorage.removeItem(TEXT_KEY);
			else localStorage.setItem(TEXT_KEY, size);
		} catch {
			// private mode: the choice lasts until the page is closed
		}
	}
}

export const textSize = new TextSizeChoice();

/** Puts this device's text size on <html>. */
export function applyTextSize(size: TextSize): void {
	if (size === 'normal') delete document.documentElement.dataset.textSize;
	else document.documentElement.dataset.textSize = size;
}
