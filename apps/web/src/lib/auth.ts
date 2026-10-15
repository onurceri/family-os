/**
 * Thin wrapper over the identity endpoints (/api/auth/*). The web app deliberately does not use
 * the auth library's client, so the identity adapter can change behind the server.
 */
import { offline } from './offline.svelte.js';

export type SignInResult =
	| { kind: 'ok' | 'invalid' | 'untrusted' | 'error' }
	/**
	 * Too many tries; `minutes` is the wait the server reported (rounded up, at least one).
	 * `locked`: this account had too many wrong secrets. `limited`: this device sent too many
	 * tries, which says nothing about whether a PIN was wrong.
	 */
	| { kind: 'locked' | 'limited'; minutes: number };

const result = (kind: 'ok' | 'invalid' | 'untrusted' | 'error'): SignInResult => ({ kind });

/** The wait in whole minutes, from the server's `Retry-After` (seconds); one minute if it sent none. */
function waitMinutes(res: Response): number {
	const seconds = Number(res.headers.get('retry-after') ?? res.headers.get('x-retry-after'));
	return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : 1;
}

async function post(path: string, body: unknown): Promise<SignInResult> {
	try {
		const res = await fetch(`/api/auth${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (res.ok) return result('ok');
		if (res.status === 429) {
			const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
			return { kind: body?.code === 'LOCKED' ? 'locked' : 'limited', minutes: waitMinutes(res) };
		}
		if (res.status === 403) return result('untrusted');
		if (res.status === 401 || res.status === 400) return result('invalid');
		return result('error');
	} catch {
		return result('error');
	}
}

export const signInWithPassword = (email: string, password: string) =>
	post('/sign-in/email', { email, password });

export const signInWithPin = (memberId: string, pin: string) =>
	post('/sign-in/pin', { memberId, pin });

export async function signOut(): Promise<void> {
	// Nothing of this person stays in the browser: waiting changes and cached reads.
	await offline.reset();
	await fetch('/api/auth/sign-out', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}',
	});
}
