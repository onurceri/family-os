/**
 * A refused change, said in words. The server's 403 carries a `reason` (and the `capability` that
 * would allow it); the words come from the reader's language and never name an action or a
 * capability, which mean nothing to a family.
 */
export const REFUSAL_KEYS: Record<string, string> = {
	capability: 'refused_capability',
	approval: 'refused_approval',
	display: 'refused_display',
	sign_in: 'refused_sign_in',
	ai: 'refused_ai',
	critical: 'refused_critical',
	area: 'refused_area',
};

/** The catalog key for a refusal's reason; an unknown or missing reason is a role refusal. */
export function refusalKey(reason: unknown): string {
	return (typeof reason === 'string' && REFUSAL_KEYS[reason]) || 'refused_capability';
}

/** The `reason` of a refusal's body (`{ error: { reason } }`), if it has one. */
export function reasonOfBody(body: unknown): string | undefined {
	const reason = (body as { error?: { reason?: unknown } } | null)?.error?.reason;
	return typeof reason === 'string' ? reason : undefined;
}

/** What a page's `catch` can learn from an error: whether it was a refusal and why. */
export function refusalOfError(error: unknown): { reason?: string } | null {
	const e = error as { status?: unknown; reason?: unknown } | null;
	if (!e || typeof e !== 'object' || e.status !== 403) return null;
	return typeof e.reason === 'string' ? { reason: e.reason } : {};
}

/** How long a refusal's words are the only notice: the page's own "try again" would hide them. */
export const REFUSAL_QUIET_MS = 1500;

/**
 * Remembers when a refusal was said, so the generic failure notice the page shows right after
 * (its `catch` knows nothing of the cause) does not replace the words.
 */
export class RefusalWindow {
	#until = 0;
	#last: string | undefined;
	said(message: string, now = Date.now()): void {
		this.#until = now + REFUSAL_QUIET_MS;
		this.#last = message;
	}
	/** Whether a plain notice should give way to a refusal just said. */
	quiet(now = Date.now()): boolean {
		return now < this.#until;
	}
	/** The words of a refusal said just now, for a form that shows its error inline. */
	recent(now = Date.now()): string | undefined {
		return now < this.#until ? this.#last : undefined;
	}
}
