/**
 * A name another person reads (an app on the consent page, a connected app, a display or device): printable text
 * only. Control, format (bidi overrides, zero-width), line and paragraph separator characters are dropped, runs of
 * whitespace become one space, and the result is trimmed and cut to `max` characters.
 */
export function shownName(name: string, max = 60): string {
	return name
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (/\s/u.test(c) ? ' ' : ''))
		.replace(/\s+/gu, ' ')
		.trim()
		.slice(0, max)
		.trim();
}
