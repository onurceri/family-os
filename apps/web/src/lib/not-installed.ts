/**
 * Which extension a path would belong to if it were installed. An extension that is not installed
 * is not loaded, so the shell cannot know its pages; the one thing it can read is the extension
 * list a person who manages extensions may fetch, matched on the path's first segment (an
 * extension's pages live under its own id). Nothing here names an extension.
 */
export interface KnownExtension {
	id: string;
	status: string;
}

/** The extension the path's first segment names, when the server has it but it does not run. */
export function notInstalledOwner<T extends KnownExtension>(
	pathname: string,
	known: readonly T[],
): T | undefined {
	const first = pathname.split('/').find((part) => part !== '');
	if (!first) return undefined;
	return known.find(
		(e) => e.id === first && (e.status === 'available' || e.status === 'pending_install'),
	);
}
