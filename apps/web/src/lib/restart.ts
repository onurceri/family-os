/**
 * Waiting for the server to restart, and noticing that it did. `/health` answers with the id of
 * the server's start (`boot`), a new one at every start; the extensions it runs have a fingerprint
 * that changes whenever one of them is installed, uninstalled or updated.
 */

/** The server's start id, or null while it does not answer (it is stopping or starting). */
export async function readBoot(fetcher: typeof fetch = fetch): Promise<string | null> {
	try {
		const response = await fetcher('/health', { cache: 'no-store' });
		if (!response.ok) return null;
		const body = (await response.json()) as { boot?: unknown };
		return typeof body.boot === 'string' ? body.boot : null;
	} catch {
		return null;
	}
}

export interface WaitOptions {
	/** The start id before the restart was asked for (null if it was not known). */
	before: string | null;
	read: () => Promise<string | null>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	every?: number;
	/** After this long the page stops waiting and says so; the server may still come back. */
	timeoutMs?: number;
	/** Stops waiting (the page was left). */
	signal?: AbortSignal;
}

/**
 * Asks until the server answers with another start id. Without a known id before, a server that
 * was seen down and answers again has restarted.
 */
export async function waitForRestart(
	options: WaitOptions,
): Promise<'restarted' | 'timeout' | 'aborted'> {
	const every = options.every ?? 1000;
	const until = options.now() + (options.timeoutMs ?? 120_000);
	let seenDown = false;
	while (options.now() < until) {
		if (options.signal?.aborted) return 'aborted';
		const boot = await options.read();
		if (boot === null) seenDown = true;
		else if (options.before === null ? seenDown : boot !== options.before) return 'restarted';
		await options.sleep(every);
	}
	return 'timeout';
}

/**
 * Whether the server runs other extensions than the ones this page loaded. An unknown fingerprint
 * on either side (an older server, a page saved to disk) is no reason to reload.
 */
export const extensionsChanged = (loaded: string, current: string | undefined): boolean =>
	loaded !== '' && current !== undefined && current !== '' && current !== loaded;
