/**
 * Where to go once a person has signed in: the sign-in page of an AI app they were sent to, which
 * would otherwise be lost on the way through the sign-in form. Only that page is ever remembered,
 * so what is stored can never send anyone anywhere else.
 */
const KEY = 'famos.returnTo';
const CONNECT = /^\/connect\/[A-Za-z0-9_-]{1,100}$/;

/** Whether `path` is a page worth coming back to after signing in. */
export const isReturnable = (path: string): boolean => CONNECT.test(path);

/** Remembers the page for after sign-in; anything else is forgotten. */
export function rememberReturn(path: string, storage: Storage | undefined = safeStorage()): void {
	try {
		if (isReturnable(path)) storage?.setItem(KEY, path);
	} catch {
		// Without storage the person lands on Today and opens the link again.
	}
}

/** The remembered page, once. */
export function takeReturn(storage: Storage | undefined = safeStorage()): string | null {
	try {
		const path = storage?.getItem(KEY) ?? null;
		storage?.removeItem(KEY);
		return path !== null && isReturnable(path) ? path : null;
	} catch {
		return null;
	}
}

function safeStorage(): Storage | undefined {
	try {
		return globalThis.sessionStorage;
	} catch {
		return undefined;
	}
}
