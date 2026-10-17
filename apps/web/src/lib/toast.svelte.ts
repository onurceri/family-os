import { RefusalWindow } from './refusal.js';
import { ACTION_MS, HoldableTimer, PLAIN_MS } from './toast-timer.js';

/**
 * App-wide notices ("Added to calendar · Undo"). One at a time; a new one replaces the old.
 * Messages auto-dismiss; the action stays available until then. A notice with an action (Undo)
 * stays longer, and waits while the pointer or keyboard focus is on it.
 */
interface Notice {
	id: number;
	message: string;
	actionLabel?: string;
	onaction?: () => void;
}

class Toasts {
	current = $state<Notice | null>(null);
	#timer = new HoldableTimer();
	#seq = 0;

	/** The last refusal said, so a page's generic failure notice does not cover it. */
	readonly refusals = new RefusalWindow();

	/** A refused change, in words: it stays the notice while the page reports its own failure. */
	refuse(message: string) {
		this.show(message);
		this.refusals.said(message);
	}

	show(message: string, action?: { label: string; run: () => void }, durationMs?: number) {
		if (!action && this.refusals.quiet() && message !== this.current?.message) return;
		const id = ++this.#seq;
		this.current = {
			id,
			message,
			...(action && {
				actionLabel: action.label,
				onaction: () => {
					this.dismiss();
					action.run();
				},
			}),
		};
		this.#timer.start(durationMs ?? (action ? ACTION_MS : PLAIN_MS), () => {
			if (this.current?.id === id) this.current = null;
		});
	}

	/** The pointer or focus is on the notice: keep it until they leave. */
	hold() {
		this.#timer.hold();
	}

	/** They left: the rest of the time runs. */
	release() {
		this.#timer.release();
	}

	dismiss() {
		this.#timer.cancel();
		this.current = null;
	}
}

export const toasts = new Toasts();
