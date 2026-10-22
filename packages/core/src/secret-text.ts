/** Helpers for secrets that are shown once and stored only as a SHA-256. Web Crypto only. */

export function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Bytes(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function sha256Hex(text: string): Promise<string> {
	return [...(await sha256Bytes(text))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `bytes` random bytes, URL-safe. */
export const randomSecret = (bytes = 32): string =>
	toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

/** Compares two strings in time that depends only on their lengths. */
export function sameText(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	let diff = x.length ^ y.length;
	const n = Math.max(x.length, y.length);
	for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}
