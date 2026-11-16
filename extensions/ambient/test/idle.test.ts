import { describe, expect, it } from 'vitest';
import {
	COVER_EVENTS,
	countsAsUse,
	coverInput,
	hasCover,
	idleSince,
	shouldCover,
	USE_EVENTS,
} from '../src/web/idle.js';

const base = {
	idle: true,
	covering: false,
	overlayOpen: false,
	lastActivity: 0,
	now: 5 * 60_000,
	idleMinutes: 5,
};

describe('when ambient mode takes over', () => {
	it('covers the screen once nobody has touched it for the idle time', () => {
		expect(shouldCover(base)).toBe(true);
		expect(shouldCover({ ...base, now: 5 * 60_000 - 1 })).toBe(false);
	});

	it('does not take over a screen that has pages, however long it is left', () => {
		expect(shouldCover({ ...base, idle: false, now: 24 * 60 * 60_000 })).toBe(false);
	});

	it('waits while a dialog or a side panel is open, however long the screen was left', () => {
		expect(shouldCover({ ...base, overlayOpen: true, now: 24 * 60 * 60_000 })).toBe(false);
	});

	it('counts the idle time from when the dialog or panel closed', () => {
		const closedAt = 60 * 60_000;
		// Open: the wait keeps starting again from now.
		expect(idleSince(0, closedAt, true)).toBe(closedAt);
		// Closed: it runs from there, and the cover comes after the whole idle time.
		const since = idleSince(closedAt, closedAt + 1000, false);
		expect(since).toBe(closedAt);
		expect(shouldCover({ ...base, lastActivity: since, now: closedAt + 4 * 60_000 })).toBe(false);
		expect(shouldCover({ ...base, lastActivity: since, now: closedAt + 5 * 60_000 })).toBe(true);
	});

	it('has nothing to start while it already covers the screen', () => {
		expect(shouldCover({ ...base, covering: true })).toBe(false);
	});
});

describe('what it covers the screen with', () => {
	const display = { photosOnly: false, canPhotos: true, canWeather: false, photoCount: 0 };
	const device = { photosOnly: true, canPhotos: true, canWeather: true, photoCount: 3 };

	it('a display covers with photos, the weather or a calm clock, whichever it may see', () => {
		expect(hasCover(display)).toBe(true);
		expect(hasCover({ ...display, canPhotos: false, canWeather: true })).toBe(true);
		expect(hasCover({ ...display, canPhotos: false })).toBe(false);
	});

	it('a family device covers only with photos that exist and that the person may see', () => {
		expect(hasCover(device)).toBe(true);
		expect(hasCover({ ...device, photoCount: 0 })).toBe(false);
		expect(hasCover({ ...device, photoCount: null })).toBe(false);
		// The weather alone would be a clock screen over the app.
		expect(hasCover({ ...device, canPhotos: false })).toBe(false);
	});
});

describe('the touch that takes the cover away', () => {
	it('reaches the app as usual while nothing covers it', () => {
		for (const type of COVER_EVENTS) expect(coverInput(type, false)).toBe('pass');
	});

	it('is kept from the app from its start to its click, which ends the cover', () => {
		for (const type of ['pointerdown', 'mousedown', 'touchstart', 'mouseup'])
			expect(coverInput(type, true), type).toBe('hold');
		expect(coverInput('pointerup', true)).toBe('endSoon');
		expect(coverInput('touchend', true)).toBe('endSoon');
		expect(coverInput('click', true)).toBe('end');
	});

	it('a key ends the cover and is not typed into the app', () => {
		expect(coverInput('keydown', true)).toBe('end');
	});
});

describe('the wheel and the mouse', () => {
	it('count as use but are not input the cover swallows', () => {
		for (const name of USE_EVENTS) {
			expect((COVER_EVENTS as readonly string[]).includes(name)).toBe(false);
			expect(coverInput(name, true)).toBe('hold');
		}
		expect([...USE_EVENTS].sort()).toEqual(['pointermove', 'wheel']);
	});

	it('count at most once a second', () => {
		expect(countsAsUse(0, 999)).toBe(false);
		expect(countsAsUse(0, 1000)).toBe(true);
	});
});
