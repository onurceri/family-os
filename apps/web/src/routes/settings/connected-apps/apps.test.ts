import { describe, expect, it } from 'vitest';
import { appIsLive, expiryState, nextWarning } from './apps.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 0, 1);

describe('expiryState', () => {
	it('never ends without an expiry', () => {
		expect(expiryState({ expiresAt: null, revokedAt: null }, now, 14)).toEqual({ kind: 'never' });
	});
	it('warns inside the warning window and not before', () => {
		expect(expiryState({ expiresAt: now + 14 * DAY, revokedAt: null }, now, 14).kind).toBe('soon');
		expect(expiryState({ expiresAt: now + 15 * DAY, revokedAt: null }, now, 14).kind).toBe('later');
	});
	it('says expired and revoked, revoked first', () => {
		expect(expiryState({ expiresAt: now - 1, revokedAt: null }, now, 14)).toEqual({
			kind: 'expired',
		});
		expect(expiryState({ expiresAt: now + DAY, revokedAt: now - 5 }, now, 14)).toEqual({
			kind: 'revoked',
		});
	});
});

describe('nextWarning', () => {
	it('is the soonest ending among live keys, or null', () => {
		const keys = [
			{ expiresAt: now + 10 * DAY, revokedAt: null },
			{ expiresAt: now + 3 * DAY, revokedAt: null },
			{ expiresAt: now + 2 * DAY, revokedAt: now },
			{ expiresAt: null, revokedAt: null },
		];
		expect(nextWarning(keys, now, 14)).toBe(now + 3 * DAY);
		expect(nextWarning([{ expiresAt: null, revokedAt: null }], now, 14)).toBeNull();
	});
});

describe('appIsLive', () => {
	it('is false when revoked or paused', () => {
		expect(appIsLive({ revokedAt: null, pausedAt: null })).toBe(true);
		expect(appIsLive({ revokedAt: null, pausedAt: 1 })).toBe(false);
		expect(appIsLive({ revokedAt: 1, pausedAt: null })).toBe(false);
	});
});
