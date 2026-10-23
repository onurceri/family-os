// The SDK is typed without DOM or Node libraries; every runtime that loads it has `URL`.
declare const URL: new (url: string, base?: string) => { readonly origin: string };

/**
 * Whether `path` is a path on `base`'s own origin and nothing else. A URL parser treats a
 * backslash like a slash and drops tabs and newlines, so `/\host`, `/%5Chost` decoded by a
 * client, or `\t//host` can name another site although they start with a slash; such text is
 * refused outright rather than parsed.
 */
export function isSameOriginPath(path: string | null | undefined, base: string): boolean {
	if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return false;
	// Backslashes, percent-encoded backslashes and control characters (including DEL).
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
	if (/[\\\u0000-\u001f\u007f]|%5c/i.test(path)) return false;
	try {
		return new URL(path, base).origin === new URL(base).origin;
	} catch {
		return false;
	}
}
