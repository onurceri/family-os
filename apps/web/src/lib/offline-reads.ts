/** A path pattern (`/api/v1/<id>/things/:thingId/parts`) as a test on a request path. */
export function offlineReadMatcher(patterns: readonly string[]): (pathname: string) => boolean {
	const parts = patterns.map((pattern) => pattern.split('/'));
	return (pathname) => {
		const segments = pathname.split('/');
		return parts.some(
			(part) =>
				part.length === segments.length &&
				part.every((p, i) => (p.startsWith(':') ? !!segments[i] : p === segments[i])),
		);
	};
}

/** Whether a message from the app is a list of path patterns the worker can trust the shape of. */
export function offlinePatternsOf(data: unknown): string[] {
	if (!Array.isArray(data)) return [];
	return data.filter((p): p is string => typeof p === 'string' && /^\/api\/v1\/[\w:/-]+$/.test(p));
}
