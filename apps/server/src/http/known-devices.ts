import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { parse, serialize } from 'hono/utils/cookie';

/**
 * Browsers that signed in to an account with its password before. Wrong passwords from elsewhere
 * can lock the account against unknown devices; a browser holding this cookie for the account is
 * still let through (its own wrong passwords still lock it), so a stranger cannot keep a person out
 * of their own family's server.
 *
 * The cookie is HttpOnly, SameSite=Strict, scoped to the sign-in endpoints, and holds one signed
 * entry per account: `<account tag>.<issued>.<signature>`. The tag is a keyed hash of the email,
 * so the cookie never names the person, and only this server can make or check an entry.
 */
export const KNOWN_DEVICE_COOKIE = 'famos_signed_in';
/** Browsers cap cookie lifetimes at ~400 days; a sign-in renews the entry. */
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
/** Accounts one browser remembers: a shared laptop is used by a few adults, not more. */
const MAX_ACCOUNTS = 5;

export interface KnownDevices {
	/** Whether the `cookie` header holds a valid entry for this account's email. */
	knows(cookieHeader: string | null, email: string): boolean;
	/** A `Set-Cookie` value that adds (or renews) this account in the browser's cookie. */
	remember(cookieHeader: string | null, email: string, secure: boolean): string;
}

export function createKnownDevices(secret: string, now: () => number = Date.now): KnownDevices {
	const key = Buffer.from(hkdfSync('sha256', secret, 'famos', 'known-sign-in-devices', 32));
	const mac = (text: string, bytes: number) =>
		createHmac('sha256', key).update(text).digest().subarray(0, bytes).toString('base64url');
	const tagOf = (email: string) => mac(`account\0${email.toLowerCase()}`, 12);
	const sign = (tag: string, issued: string) => mac(`entry\0${tag}.${issued}`, 16);

	/** The valid entries of the cookie, newest first. */
	function entries(cookieHeader: string | null) {
		const value = cookieHeader ? parse(cookieHeader, KNOWN_DEVICE_COOKIE)[KNOWN_DEVICE_COOKIE] : '';
		const valid: { tag: string; text: string }[] = [];
		for (const text of (value ?? '').split('~').slice(0, MAX_ACCOUNTS)) {
			const [tag = '', issued = '', signature = '', extra] = text.split('.');
			if (!tag || !issued || !signature || extra !== undefined) continue;
			const expected = Buffer.from(sign(tag, issued));
			const given = Buffer.from(signature);
			if (given.length !== expected.length || !timingSafeEqual(given, expected)) continue;
			const at = Number.parseInt(issued, 36);
			if (!Number.isFinite(at) || at > now() || now() - at > MAX_AGE_SECONDS * 1000) continue;
			valid.push({ tag, text });
		}
		return valid;
	}

	return {
		knows(cookieHeader, email) {
			const tag = tagOf(email);
			return entries(cookieHeader).some((entry) => entry.tag === tag);
		},
		remember(cookieHeader, email, secure) {
			const tag = tagOf(email);
			const issued = now().toString(36);
			const others = entries(cookieHeader).filter((entry) => entry.tag !== tag);
			const value = [`${tag}.${issued}.${sign(tag, issued)}`, ...others.map((e) => e.text)]
				.slice(0, MAX_ACCOUNTS)
				.join('~');
			return serialize(KNOWN_DEVICE_COOKIE, value, {
				httpOnly: true,
				secure,
				sameSite: 'Strict',
				path: '/api/auth',
				maxAge: MAX_AGE_SECONDS,
			});
		},
	};
}
