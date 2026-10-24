import { DAY_MS } from '@famos/time';

/** Where a key stands: it never ends, ends later, ends soon (warn), has ended, or was revoked. */
export type ExpiryState =
	| { kind: 'revoked' }
	| { kind: 'expired' }
	| { kind: 'soon'; at: number }
	| { kind: 'later'; at: number }
	| { kind: 'never' };

export function expiryState(
	token: { expiresAt: number | null; revokedAt: number | null },
	now: number,
	warnDays: number,
): ExpiryState {
	if (token.revokedAt !== null) return { kind: 'revoked' };
	if (token.expiresAt === null) return { kind: 'never' };
	if (token.expiresAt <= now) return { kind: 'expired' };
	return token.expiresAt - now <= warnDays * DAY_MS
		? { kind: 'soon', at: token.expiresAt }
		: { kind: 'later', at: token.expiresAt };
}

/** Whether an app still works for anyone: not revoked, not paused. */
export const appIsLive = (app: { revokedAt: number | null; pausedAt: number | null }): boolean =>
	app.revokedAt === null && app.pausedAt === null;

/** The soonest warning among an app's live keys, or null when none ends soon. */
export function nextWarning(
	tokens: readonly { expiresAt: number | null; revokedAt: number | null }[],
	now: number,
	warnDays: number,
): number | null {
	let soonest: number | null = null;
	for (const token of tokens) {
		const state = expiryState(token, now, warnDays);
		if (state.kind === 'soon' && (soonest === null || state.at < soonest)) soonest = state.at;
	}
	return soonest;
}

/**
 * Whether a row says "Signed in": only while the sign-in still works. A revoked or ended one reads
 * like a revoked key (its scope, that it was revoked, when it was last used).
 */
export const showsSignedIn = (
	token: { signedIn: boolean; expiresAt: number | null; revokedAt: number | null },
	now: number,
): boolean =>
	token.signedIn && token.revokedAt === null && (token.expiresAt === null || token.expiresAt > now);
