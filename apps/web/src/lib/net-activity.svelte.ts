import { beginWork, forgetSharedReads, pendingWork } from '@famos/ui/famos';

import { reasonOfBody } from './refusal.js';

/**
 * Whether a page is still opening. The page gate (`PageGate.svelte`) keeps a page invisible until
 * its first data has arrived, which is when this count settles at zero. It counts the reads (GET
 * requests to this server) from the moment they are sent until their answer has been read, and
 * all the other work that leads to the next read (`pendingWork` from `@famos/ui`: navigations on
 * their way, lazy components loading). Counting at `fetch` itself covers every page and every
 * extension without anything to report: a page only loads its data the way it already does.
 */
class NetActivity {
	/** Reads and other work in flight (reactive). */
	get pending(): number {
		return pendingWork.current;
	}
	#installed = false;
	/** Called when a change was refused (403), so the app can read what the person may do again. */
	onForbidden: ((reason: string | undefined) => void) | undefined;

	/** Wraps `fetch` once. Writes (actions) and other origins are not counted. */
	install(): void {
		if (this.#installed || typeof window === 'undefined') return;
		this.#installed = true;
		const original = window.fetch.bind(window);
		window.fetch = (input, init) => {
			// A write changes what reads would answer: none may be shared across it.
			if (this.#writes(input, init)) forgetSharedReads();
			const request = original(input, init);
			// Refused: the role may have changed since the controls were drawn.
			if (this.#writes(input, init)) {
				void request.then(
					async (response) => {
						if (response.status !== 403) return;
						// The reason is in the body; read a copy so the caller's own read is untouched.
						const body: unknown = await response
							.clone()
							.json()
							.catch(() => null);
						this.onForbidden?.(reasonOfBody(body));
					},
					() => {},
				);
			}
			if (this.#counts(input, init)) {
				const done = beginWork();
				request.then((response) => untilRead(response, done), done);
			}
			return request;
		};
	}

	#counts(input: RequestInfo | URL, init?: RequestInit): boolean {
		return this.#method(input, init) === 'GET' && this.#ownApi(input);
	}

	#writes(input: RequestInfo | URL, init?: RequestInit): boolean {
		return this.#method(input, init) !== 'GET' && this.#ownApi(input);
	}

	#method(input: RequestInfo | URL, init?: RequestInit): string {
		return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
	}

	#ownApi(input: RequestInfo | URL): boolean {
		const raw = input instanceof Request ? input.url : String(input);
		try {
			const url = new URL(raw, location.href);
			return url.origin === location.origin && url.pathname.startsWith('/api/');
		} catch {
			return false;
		}
	}
}

const BODY_READS = ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'] as const;

/**
 * Ends a read once its answer has been read, not when its headers arrive: the caller's next read
 * often waits for this one's body. A body nobody starts reading by the next macrotask (no content,
 * or a caller that only looks at the status) ends the read then.
 */
function untilRead(response: Response, done: () => void): void {
	let reading = false;
	for (const name of BODY_READS) {
		const read = response[name] as (() => Promise<unknown>) | undefined;
		if (typeof read !== 'function') continue;
		Object.defineProperty(response, name, {
			configurable: true,
			value: () => {
				reading = true;
				const body = read.call(response);
				body.then(done, done);
				return body;
			},
		});
	}
	setTimeout(() => {
		if (!reading) done();
	}, 0);
}

export const netActivity = new NetActivity();

/** Whether the signed-in shell has finished switching to the person's language. */
export const shellState = $state({ languageReady: false });
