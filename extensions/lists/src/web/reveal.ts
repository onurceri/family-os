/** What `revealWhenRendered` needs from the page; the defaults are the browser's. */
export interface RevealEnv {
	find(): Pick<Element, 'scrollIntoView'> | null;
	frame(run: () => void): void;
	smooth: boolean;
	/** How many frames to wait for the row to be drawn before giving up. */
	frames?: number;
}

/**
 * Scrolls a row into view once it is drawn. A row that was just added appears only after the list
 * has been read again, so this waits for it a short while; it stops quietly when it never comes.
 * `block: 'nearest'` leaves the page alone when the row is already fully visible, and the page's
 * scroll padding keeps it clear of a bar fixed to the bottom of a phone.
 */
export function revealWhenRendered(env: RevealEnv): void {
	let left = env.frames ?? 120;
	const look = () => {
		const row = env.find();
		if (row) {
			row.scrollIntoView({ block: 'nearest', behavior: env.smooth ? 'smooth' : 'auto' });
			return;
		}
		if (--left > 0) env.frame(look);
	};
	env.frame(look);
}

/** Reveals the row with this `data-item-id` (or `data-task-id`) in the open page. */
export function revealRow(attribute: 'data-item-id' | 'data-task-id', id: string): void {
	revealWhenRendered({
		find: () => document.querySelector(`[${attribute}="${CSS.escape(id)}"]`),
		frame: (run) => requestAnimationFrame(run),
		smooth: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
	});
}
