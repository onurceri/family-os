import type { RunActionOptions, RunActionResult, WaitingChange } from '@famos/ui/app';
import { t } from './i18n.svelte.js';
import { createBrowserStore } from './offline-idb.js';
import { type FailedChange, OfflineQueue, type QueuedChange } from './offline-queue.js';
import { sendAction } from './offline-send.js';
import { session } from './session.svelte.js';
import { toasts } from './toast.svelte.js';

/** Replay waiting changes this often while some wait. */
const REPLAY_EVERY_MS = 30_000;

/**
 * Reactive face of the offline queue: what waits, what could not be saved, whether we are
 * showing stale data. The logic lives in `offline-queue.ts`.
 */
class Offline {
	waiting = $state<QueuedChange[]>([]);
	failed = $state<FailedChange[]>([]);
	/** The browser has no connection. */
	offline = $state(typeof navigator !== 'undefined' && navigator.onLine === false);
	/** A read was answered from the service worker's last-seen copy. */
	stale = $state(false);

	#queue = new OfflineQueue({
		store: createBrowserStore(() => toasts.show(t('offline_not_kept'))),
		send: (actionId, input, key) => sendAction(actionId, input, key),
		memberId: () => session.me?.id ?? null,
		isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
		now: () => Date.now(),
		newKey: () => crypto.randomUUID(),
		onChange: () => this.#sync(),
	});
	#started = false;

	#sync() {
		this.waiting = this.#queue.waiting();
		this.failed = this.#queue.failedForMe();
	}

	/** Whether the page should say "Offline — showing what was last seen". */
	get showingOld() {
		return this.offline || this.stale;
	}

	/** Loads the stored queue and starts replaying; call once the member is known. */
	start(): () => void {
		if (this.#started || typeof window === 'undefined') return () => {};
		this.#started = true;
		const flush = (force = false) => void this.#queue.flush({ force }).catch(() => {});
		void this.#queue.load().then(() => flush(true));
		const onOnline = () => {
			this.offline = false;
			this.stale = false;
			flush(true);
		};
		const onOffline = () => (this.offline = true);
		const onMessage = (event: MessageEvent) => {
			if ((event.data as { type?: string } | null)?.type === 'FAMOS_SERVED_OFFLINE')
				this.stale = true;
		};
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);
		navigator.serviceWorker?.addEventListener('message', onMessage);
		const timer = setInterval(() => {
			if (!navigator.onLine) return;
			if (this.#queue.waiting().length > 0) flush();
			// Old data shown because the server did not answer: is it back?
			if (this.stale) {
				void fetch('/health', { cache: 'no-store' }).then(
					(response) => {
						if (response.ok) this.stale = false;
					},
					() => {},
				);
			}
		}, REPLAY_EVERY_MS);
		return () => {
			clearInterval(timer);
			window.removeEventListener('online', onOnline);
			window.removeEventListener('offline', onOffline);
			navigator.serviceWorker?.removeEventListener('message', onMessage);
			this.#started = false;
		};
	}

	async run<O>(
		actionId: string,
		input: unknown,
		options?: RunActionOptions,
	): Promise<RunActionResult<O>> {
		const result = await this.#queue.run<O>(actionId, input, options);
		// Any answer means the server is reachable: the last-seen notice no longer applies.
		if (!result.queued) this.stale = false;
		else if (navigator.onLine) void this.#queue.flush().catch(() => {});
		return result;
	}

	waitingChanges(): readonly WaitingChange[] {
		return this.waiting.map(({ actionId, input }) => ({ actionId, input }));
	}

	/**
	 * The signed-in member changed: show their queue. Cached reads belong to whoever was signed in
	 * when they were fetched; on a shared family device a session can end without a sign-out (it
	 * expires) and someone else sign in, so another member's last-seen copy is dropped here.
	 */
	resync() {
		const me = session.me?.id ?? null;
		let last: string | null = null;
		try {
			last = localStorage.getItem(LAST_MEMBER_KEY);
			if (me) localStorage.setItem(LAST_MEMBER_KEY, me);
		} catch {
			// Storage unavailable (private mode): fall through and clear to be safe.
		}
		if (me && last !== me) clearCachedReads();
		this.#sync();
	}

	/** Nobody is signed in (signed out or the session expired): no member's reads stay cached. */
	forgetReads() {
		clearCachedReads();
	}

	dismissFailed(key?: string) {
		void this.#queue.dismissFailed(key);
	}

	/** Sign-out: forget everything of this browser's session (queue, notices, cached reads). */
	async reset(): Promise<void> {
		await this.#queue.clear().catch(() => {});
		this.stale = false;
		clearCachedReads();
	}
}

const LAST_MEMBER_KEY = 'famos-offline-member';

function clearCachedReads(): void {
	navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_API_CACHE' });
}

export const offline = new Offline();
