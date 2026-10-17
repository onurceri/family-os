import type { RunActionOptions, RunActionResult } from '@famos/ui/app';

/**
 * The offline command queue, without any framework or browser API so it can be
 * tested: storage, the network and the clock are injected. Never log `input`: it is family
 * content.
 */

export interface QueuedChange {
	/** The `Idempotency-Key` of the request; the same key is used by every replay. */
	key: string;
	actionId: string;
	input: unknown;
	memberId: string;
	createdAt: number;
	/** What the person did, in their language ("Tick off milk"); shown if it could not be saved. */
	label: string | null;
	attempts: number;
	/** Not before this time (epoch ms), after a failed attempt. */
	nextAttemptAt: number;
}

/** A queued change the server refused. The input is dropped: only a label stays. */
export interface FailedChange {
	key: string;
	actionId: string;
	memberId: string;
	createdAt: number;
	failedAt: number;
	label: string | null;
	status: number;
	message: string;
}

export interface QueueStore {
	list(): Promise<QueuedChange[]>;
	put(change: QueuedChange): Promise<void>;
	remove(key: string): Promise<void>;
	listFailed(): Promise<FailedChange[]>;
	putFailed(failed: FailedChange): Promise<void>;
	removeFailed(key: string): Promise<void>;
	clear(): Promise<void>;
}

/** What the server answered. `send` throws (any error) when there was no answer at all. */
export interface SendResult {
	status: number;
	body: unknown;
}

export interface QueueDeps {
	store: QueueStore;
	send(actionId: string, input: unknown, key: string): Promise<SendResult>;
	/** The signed-in member; the queue never sends another member's changes. */
	memberId(): string | null;
	isOnline(): boolean;
	now(): number;
	newKey(): string;
	/** Called after every change of the lists below. */
	onChange?(): void;
}

/** A non-2xx answer of an action call, in the shape of the API client's errors. */
export class ActionError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details: unknown;
	/** Why a 403 refused, when the server says. */
	readonly reason: string | undefined;
	constructor(status: number, code: string, message: string, details?: unknown, reason?: string) {
		super(message);
		this.name = 'ActionError';
		this.status = status;
		this.code = code;
		this.details = details;
		this.reason = reason;
	}
}

const ACTION_ID = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;

export const backoffMs = (attempts: number) =>
	Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

/** A refusal that will not change by trying again; anything else keeps the change queued. */
const isFinalRefusal = (status: number) =>
	status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;

function errorOf(result: SendResult): {
	code: string;
	message: string;
	details: unknown;
	reason: string | undefined;
} {
	const error = (
		result.body as {
			error?: { code?: unknown; message?: unknown; details?: unknown; reason?: unknown };
		}
	)?.error;
	return {
		code: typeof error?.code === 'string' ? error.code : 'unknown',
		message: typeof error?.message === 'string' ? error.message : `Error ${result.status}`,
		details: error?.details,
		reason: typeof error?.reason === 'string' ? error.reason : undefined,
	};
}

export class OfflineQueue {
	#deps: QueueDeps;
	#changes: QueuedChange[] = [];
	#failed: FailedChange[] = [];
	#flushing: Promise<void> | null = null;
	#lastAt = 0;

	constructor(deps: QueueDeps) {
		this.#deps = deps;
	}

	/** All queued changes, oldest first (every member's; use `waiting()` for the current one). */
	get changes(): readonly QueuedChange[] {
		return this.#changes;
	}
	get failed(): readonly FailedChange[] {
		return this.#failed;
	}
	/** Changes of the signed-in member. */
	waiting(): QueuedChange[] {
		const me = this.#deps.memberId();
		return me ? this.#changes.filter((c) => c.memberId === me) : [];
	}
	failedForMe(): FailedChange[] {
		const me = this.#deps.memberId();
		return me ? this.#failed.filter((c) => c.memberId === me) : [];
	}

	async load(): Promise<void> {
		this.#changes = (await this.#deps.store.list()).toSorted(byAge);
		this.#lastAt = this.#changes.at(-1)?.createdAt ?? 0;
		this.#failed = (await this.#deps.store.listFailed()).toSorted(
			(a, b) => a.failedAt - b.failedAt,
		);
		this.#deps.onChange?.();
	}

	/**
	 * Calls an action. Without a network and with `offline`, the call is queued instead and
	 * `{ queued: true }` returned; any answer from the server (even an error) is final here.
	 */
	async run<O>(
		actionId: string,
		input: unknown,
		options: RunActionOptions = {},
	): Promise<RunActionResult<O>> {
		if (!ACTION_ID.test(actionId)) throw new Error(`Invalid action id "${actionId}"`);
		const { store, memberId } = this.#deps;
		const me = memberId();
		const key = this.#deps.newKey();
		const queueIt = async (): Promise<RunActionResult<O>> => {
			if (!me) throw new ActionError(401, 'unauthenticated', 'Not signed in');
			// Strictly increasing, so the order of a tap sequence survives storage.
			this.#lastAt = Math.max(this.#deps.now(), this.#lastAt + 1);
			const change: QueuedChange = {
				key,
				actionId,
				input,
				memberId: me,
				createdAt: this.#lastAt,
				label: options.label ?? null,
				attempts: 0,
				nextAttemptAt: 0,
			};
			await store.put(change);
			this.#changes = [...this.#changes, change];
			this.#deps.onChange?.();
			return { queued: true };
		};
		if (options.offline && me) {
			// Behind earlier waiting changes: keep the order they were made in (the next flush sends both).
			if (!this.#deps.isOnline() || this.waiting().length > 0) {
				return queueIt();
			}
		}
		let result: SendResult;
		try {
			result = await this.#deps.send(actionId, input, key);
		} catch (error) {
			if (options.offline && me) return queueIt();
			throw error;
		}
		if (result.status >= 200 && result.status < 300) {
			return { queued: false, ...(result.body as object) } as RunActionResult<O>;
		}
		const { code, message, details, reason } = errorOf(result);
		throw new ActionError(result.status, code, message, details, reason);
	}

	/** Sends waiting changes in order. `force` ignores the backoff (we are online again). */
	flush(options: { force?: boolean } = {}): Promise<void> {
		this.#flushing ??= this.#flush(options.force === true).finally(() => {
			this.#flushing = null;
		});
		return this.#flushing;
	}

	async #flush(force: boolean): Promise<void> {
		const { store } = this.#deps;
		for (const change of this.waiting()) {
			if (!force && change.nextAttemptAt > this.#deps.now()) break;
			let result: SendResult;
			try {
				result = await this.#deps.send(change.actionId, change.input, change.key);
			} catch {
				await this.#later(change);
				break;
			}
			if (result.status >= 200 && result.status < 300) {
				await store.remove(change.key);
				this.#changes = this.#changes.filter((c) => c.key !== change.key);
				this.#deps.onChange?.();
			} else if (isFinalRefusal(result.status)) {
				const failed: FailedChange = {
					key: change.key,
					actionId: change.actionId,
					memberId: change.memberId,
					createdAt: change.createdAt,
					failedAt: this.#deps.now(),
					label: change.label,
					status: result.status,
					message: errorOf(result).message,
				};
				await store.putFailed(failed);
				await store.remove(change.key);
				this.#failed = [...this.#failed, failed];
				this.#changes = this.#changes.filter((c) => c.key !== change.key);
				this.#deps.onChange?.();
			} else {
				// Server trouble, rate limit or not signed in: keep it, and keep the order.
				await this.#later(change);
				break;
			}
		}
	}

	async #later(change: QueuedChange): Promise<void> {
		const attempts = change.attempts + 1;
		const next: QueuedChange = {
			...change,
			attempts,
			nextAttemptAt: this.#deps.now() + backoffMs(attempts),
		};
		await this.#deps.store.put(next);
		this.#changes = this.#changes.map((c) => (c.key === change.key ? next : c));
		this.#deps.onChange?.();
	}

	/** Hides a "could not be saved" notice (or all of the current member's). */
	async dismissFailed(key?: string): Promise<void> {
		const mine = this.failedForMe().filter((f) => key === undefined || f.key === key);
		for (const f of mine) await this.#deps.store.removeFailed(f.key);
		const gone = new Set(mine.map((f) => f.key));
		this.#failed = this.#failed.filter((f) => !gone.has(f.key));
		this.#deps.onChange?.();
	}

	/** Sign-out: nothing of this person stays in the browser. */
	async clear(): Promise<void> {
		await this.#deps.store.clear();
		this.#changes = [];
		this.#failed = [];
		this.#deps.onChange?.();
	}
}

const byAge = (a: QueuedChange, b: QueuedChange) => a.createdAt - b.createdAt;

/** A store that keeps everything in memory (tests, and browsers without IndexedDB). */
export function createMemoryStore(): QueueStore {
	const queue = new Map<string, QueuedChange>();
	const failed = new Map<string, FailedChange>();
	return {
		list: async () => [...queue.values()],
		put: async (c) => void queue.set(c.key, c),
		remove: async (key) => void queue.delete(key),
		listFailed: async () => [...failed.values()],
		putFailed: async (f) => void failed.set(f.key, f),
		removeFailed: async (key) => void failed.delete(key),
		clear: async () => {
			queue.clear();
			failed.clear();
		},
	};
}
