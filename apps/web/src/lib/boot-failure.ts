/**
 * A start that threw before the app was up (a browser feature the page needs is missing) would
 * leave the loading mark turning for good. While the app is not up, an uncaught script error
 * counts as a failed start so the shell can say what happened instead.
 */
const SCRIPT_ERRORS = [TypeError, ReferenceError, SyntaxError];

/** Whether an uncaught error means the browser cannot run the app (a failed request is a `TypeError` too, and does not). */
export function isBrowserFailure(error: unknown): boolean {
	if (!SCRIPT_ERRORS.some((kind) => error instanceof kind)) return false;
	return !/fetch|networkerror|load failed/i.test((error as Error).message);
}

export class BootGuard {
	failed = false;
	#up = false;
	readonly #onChange: (failed: boolean) => void;

	constructor(onChange: (failed: boolean) => void) {
		this.#onChange = onChange;
	}

	/** The app is showing a page: later errors are not a failed start. */
	up() {
		this.#up = true;
		this.failed = false;
		this.#onChange(false);
	}

	/** Reports an uncaught error; returns whether it counts as a failed start. */
	report(error: unknown): boolean {
		if (this.#up || !isBrowserFailure(error)) return false;
		this.failed = true;
		this.#onChange(true);
		return true;
	}

	/** Listens for uncaught errors until the app is up. */
	listen(target: Pick<Window, 'addEventListener'>) {
		target.addEventListener('error', (event) => {
			this.report(event.error);
		});
		// An async step of the start (a load, an awaited import) fails as a rejected promise.
		target.addEventListener('unhandledrejection', (event) => {
			this.report(event.reason);
		});
	}
}
