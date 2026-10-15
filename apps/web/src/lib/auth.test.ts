import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./offline.svelte.js', () => ({ offline: { reset: async () => {} } }));
const { signInWithPin } = await import('./auth.js');

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json(body, { status, headers })),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('sign-in results', () => {
	it('tells a locked account from a device that tried too often', async () => {
		answer(429, { code: 'LOCKED', retryAfter: 900 }, { 'retry-after': '900' });
		expect(await signInWithPin('member_a', '1234')).toEqual({ kind: 'locked', minutes: 15 });

		answer(429, { code: 'RATE_LIMITED', retryAfter: 40 }, { 'retry-after': '40' });
		expect(await signInWithPin('member_a', '1234')).toEqual({ kind: 'limited', minutes: 1 });
	});

	it('treats a limit without a code as too many tries, not as wrong PINs', async () => {
		answer(429, { message: 'Too many requests' }, { 'x-retry-after': '10' });
		expect(await signInWithPin('member_a', '1234')).toEqual({ kind: 'limited', minutes: 1 });
	});

	it('maps the other answers', async () => {
		answer(403, { code: 'UNTRUSTED_DEVICE' });
		expect(await signInWithPin('member_a', '1234')).toEqual({ kind: 'untrusted' });
		answer(401, { message: 'Invalid PIN' });
		expect(await signInWithPin('member_a', '1234')).toEqual({ kind: 'invalid' });
		answer(200, { ok: true });
		expect(await signInWithPin('member_a', '1234')).toEqual({ kind: 'ok' });
	});
});
