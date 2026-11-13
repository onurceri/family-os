export type SignOutSteps = {
	/** The browser has a connection. */
	online: () => boolean;
	/** Tries to send every waiting change now; never throws. */
	flush: () => Promise<void>;
	/** How many changes still wait. */
	waitingCount: () => number;
	/** Asks whether the changes still waiting may be thrown away. */
	confirmDiscard: (count: number) => Promise<boolean>;
	/** Stops this browser receiving the leaving member's notifications; may fail or hang. */
	releasePush: () => Promise<void>;
	/** Ends the session on the server; throws when that fails. */
	request: () => Promise<void>;
	/** Forgets this browser's waiting changes, notices and cached reads. */
	clear: () => Promise<void>;
};

const PUSH_RELEASE_MS = 3000;

/**
 * Signs out without losing work: waiting changes are sent first, and only what still waits
 * (offline, or a send failed) is discarded after the person agrees. The browser forgets
 * only once the server has ended the session, so a failed request leaves everything as it was.
 * Resolves `'cancelled'` when the person keeps their changes.
 */
export async function signOutSafely(steps: SignOutSteps): Promise<'signed-out' | 'cancelled'> {
	if (steps.online()) await steps.flush();
	const remaining = steps.waitingCount();
	if (remaining > 0 && !(await steps.confirmDiscard(remaining))) return 'cancelled';
	// Needs the session, so before it ends; bounded and never fatal.
	await Promise.race([
		steps.releasePush().catch(() => {}),
		new Promise<void>((resolve) => setTimeout(resolve, PUSH_RELEASE_MS)),
	]);
	await steps.request();
	await steps.clear();
	return 'signed-out';
}
