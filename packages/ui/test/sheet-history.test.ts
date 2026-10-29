import { describe, expect, it, vi } from 'vitest';
import { sheetHistory } from '../src/famos/sheet-history.js';

/** A tiny history: entries, an index, and popstate on back. */
function fakeWindow() {
	const entries: unknown[] = [{ index: 0 }];
	let at = 0;
	const listeners = new Set<() => void>();
	const win = {
		history: {
			get state() {
				return entries[at];
			},
			pushState(state: unknown) {
				entries.splice(at + 1, entries.length, state);
				at += 1;
			},
			back() {
				at -= 1;
				for (const l of [...listeners]) l();
			},
		},
		addEventListener: (_: string, l: () => void) => listeners.add(l),
		removeEventListener: (_: string, l: () => void) => listeners.delete(l),
	} as unknown as Pick<Window, 'history' | 'addEventListener' | 'removeEventListener'>;
	return {
		entries,
		get at() {
			return at;
		},
		win,
		/** The person follows a link: a new entry that is not the sheet's. */
		navigate() {
			entries.splice(at + 1, entries.length, { index: at + 1 });
			at += 1;
		},
		back() {
			win.history.back();
		},
	};
}

describe('sheetHistory', () => {
	it('adds one entry and tells when Back took it', () => {
		const w = fakeWindow();
		const onBack = vi.fn();
		const h = sheetHistory(w.win, onBack);
		h.push();
		h.push();
		expect(w.entries).toHaveLength(2);
		w.back();
		expect(onBack).toHaveBeenCalledOnce();
		expect(h.active).toBe(false);
		expect(w.at).toBe(0);
	});

	it('takes its entry off when closed another way, without calling onBack', () => {
		const w = fakeWindow();
		const onBack = vi.fn();
		const h = sheetHistory(w.win, onBack);
		h.push();
		const done = vi.fn();
		h.release(done);
		expect(done).toHaveBeenCalledOnce();
		expect(onBack).not.toHaveBeenCalled();
		expect(w.at).toBe(0);
	});

	it('leaves history alone when the person already went to another page', () => {
		const w = fakeWindow();
		const h = sheetHistory(w.win, vi.fn());
		h.push();
		w.navigate();
		const done = vi.fn();
		h.release(done);
		expect(done).toHaveBeenCalledOnce();
		expect(w.at).toBe(2);
	});

	it('runs done at once when it has no entry', () => {
		const w = fakeWindow();
		const h = sheetHistory(w.win, vi.fn());
		const done = vi.fn();
		h.release(done);
		expect(done).toHaveBeenCalledOnce();
	});

	it('can add the entry again after Back when the sheet stays open', () => {
		const w = fakeWindow();
		const h = sheetHistory(w.win, vi.fn());
		h.push();
		w.back();
		h.push();
		expect(h.active).toBe(true);
		expect(w.at).toBe(1);
	});
});
