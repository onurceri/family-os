/**
 * The Back button for a sheet. While a sheet is open it holds one history entry of its own, so
 * Back closes the sheet and leaves the page (and what was typed) alone. Closing any other way
 * (Save, Cancel, X) takes that entry off again, so history does not fill up.
 */
type HistoryWindow = Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'>;

const MARK = 'famosSheet';

export interface SheetHistory {
	/** Adds the sheet's entry (once). */
	push(): void;
	/** Whether the sheet's entry is in history. */
	readonly active: boolean;
	/**
	 * Takes the entry off, then calls `done`. If the person already moved on to another page, the
	 * entry is not ours to take any more and `done` runs at once.
	 */
	release(done?: () => void): void;
	/** Stops listening. */
	dispose(): void;
}

/** `onBack` runs when Back took the entry off; the sheet may add it again if it stays open. */
export function sheetHistory(win: HistoryWindow, onBack: () => void): SheetHistory {
	let active = false;
	let pending: (() => void) | null = null;
	let releasing = false;

	const onpop = () => {
		if (!active) return;
		active = false;
		if (releasing) {
			releasing = false;
			const done = pending;
			pending = null;
			done?.();
		} else onBack();
	};
	win.addEventListener('popstate', onpop);

	return {
		push() {
			if (active) return;
			win.history.pushState({ ...(win.history.state ?? {}), [MARK]: true }, '');
			active = true;
		},
		get active() {
			return active;
		},
		release(done) {
			if (!active) return done?.();
			if (!win.history.state?.[MARK]) {
				active = false;
				return done?.();
			}
			releasing = true;
			pending = done ?? null;
			win.history.back();
		},
		dispose() {
			win.removeEventListener('popstate', onpop);
		},
	};
}
