/** How long a notice stays: longer when it carries an action such as Undo. */
export const PLAIN_MS = 5000;
export const ACTION_MS = 10000;
/** The least time left after the pointer or focus leaves, to move away from the notice. */
const GRACE_MS = 2000;

/**
 * A dismiss timer that waits while the person is on the notice (pointer over it, or keyboard
 * focus inside) and runs on once they leave.
 */
export class HoldableTimer {
	#handle: ReturnType<typeof setTimeout> | undefined;
	#left = 0;
	#startedAt = 0;
	#done: (() => void) | undefined;

	start(ms: number, done: () => void) {
		this.#done = done;
		this.#left = ms;
		this.#arm();
	}

	hold() {
		if (!this.#done || this.#handle === undefined) return;
		clearTimeout(this.#handle);
		this.#handle = undefined;
		this.#left = Math.max(0, this.#left - (Date.now() - this.#startedAt));
	}

	release() {
		if (!this.#done || this.#handle !== undefined) return;
		this.#left = Math.max(this.#left, GRACE_MS);
		this.#arm();
	}

	cancel() {
		clearTimeout(this.#handle);
		this.#handle = undefined;
		this.#done = undefined;
	}

	#arm() {
		clearTimeout(this.#handle);
		this.#startedAt = Date.now();
		this.#handle = setTimeout(() => {
			this.#handle = undefined;
			const done = this.#done;
			this.#done = undefined;
			done?.();
		}, this.#left);
	}
}
