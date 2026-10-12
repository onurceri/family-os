/**
 * Handles (`member:2`) are for tool inputs; a person reading an answer must never see one.
 * Models still write them now and then, so the host swaps each for the member's name before the
 * text is streamed or stored. The model's text arrives in pieces, and a handle can be cut between
 * two of them: the end of a piece that might be the start of one waits for the next piece.
 */

const HANDLE = /(?<![\p{L}\p{N}_])member:(\d+)(?!\d)/gu;
/** A tail that may still grow into a handle: `m`, `me` … `member:`, `member:12`. */
const MAYBE_HANDLE = /(?:m|me|mem|memb|membe|member|member:\d*)$/;

export interface HandleScrubber {
	/** The part of the text that is safe to show so far. */
	push(text: string): string;
	/** What was held back at the end. */
	flush(): string;
}

/** `name` returns the replacement for a handle (a neutral word for one nobody can name). */
export function createHandleScrubber(name: (handle: string) => string): HandleScrubber {
	let held = '';
	// The last character already shown: it decides whether a "member:" after it starts a word.
	let before = '';
	const swap = (text: string) =>
		(before + text).replace(HANDLE, (handle) => name(handle)).slice(before.length);
	return {
		push(text) {
			const all = held + text;
			const tail = MAYBE_HANDLE.exec(all);
			const ready = tail ? all.slice(0, tail.index) : all;
			held = tail ? all.slice(tail.index) : '';
			const out = swap(ready);
			if (ready !== '') before = ready.slice(-1);
			return out;
		},
		flush() {
			const out = swap(held);
			held = '';
			before = '';
			return out;
		},
	};
}

/** The same swap for text that is complete. */
export function scrubHandles(text: string, name: (handle: string) => string): string {
	return text.replace(HANDLE, (handle) => name(handle));
}
