/**
 * The pairing state machine of a display: ask for a code, poll until an admin confirms it, ask
 * again when it expired. One attempt runs at a time and one poll loop is alive; every function
 * with a side effect is injected so the sequence can be tested with fake timers.
 */
export type Started = { deviceCode: string; userCode: string; expiresAt: number; interval: number };
export type PollStatus = 'pending' | 'slow_down' | 'expired' | 'paired';
/** The two answers a call can have; a failed one is an offline or refused request. */
export type Answer<T> = { ok: true; data: T } | { ok: false };

export type PairingView = { started: Started | null; now: number; failed: boolean };

export type PairingDeps = {
	mint: () => Promise<Answer<Started>>;
	poll: (deviceCode: string) => Promise<Answer<{ status: PollStatus }>>;
	now: () => number;
	setTimeout: (run: () => void, ms: number) => unknown;
	clearTimeout: (id: unknown) => void;
	setInterval: (run: () => void, ms: number) => unknown;
	clearInterval: (id: unknown) => void;
	onChange: (view: PairingView) => void;
	onPaired: () => void;
};

const RETRY_MS = 15_000;
const SLOW_DOWN_MS = 5000;

export function createPairing(deps: PairingDeps) {
	let started: Started | null = null;
	let now = deps.now();
	let failed = false;
	let intervalMs = 5000;
	let pollTimer: unknown;
	let retryTimer: unknown;
	let tickTimer: unknown;
	let stopped = true;
	let minting = false;
	/** Which code a poll loop belongs to: an answer from an older loop is not acted on. */
	let loop = 0;

	const publish = () => deps.onChange({ started, now, failed });

	async function begin() {
		// One attempt at a time: a second ask while one is in flight would mint a second code.
		if (stopped || minting) return;
		minting = true;
		loop++;
		deps.clearTimeout(pollTimer);
		deps.clearTimeout(retryTimer);
		let next: Answer<Started>;
		try {
			next = await deps.mint();
		} finally {
			minting = false;
		}
		if (stopped) return;
		if (next.ok) {
			started = next.data;
			intervalMs = next.data.interval * 1000;
			failed = false;
			const mine = loop;
			pollTimer = deps.setTimeout(() => void poll(mine), intervalMs);
		} else {
			// Offline, or too many codes asked for: wait and try again.
			failed = true;
			retryTimer = deps.setTimeout(() => void begin(), RETRY_MS);
		}
		publish();
	}

	async function poll(mine: number) {
		if (!started || stopped || mine !== loop) return;
		const answer = await deps.poll(started.deviceCode);
		if (stopped || mine !== loop) return;
		if (!answer.ok) {
			failed = true;
		} else {
			const status = answer.data.status;
			if (status === 'paired') {
				stopped = true;
				deps.clearInterval(tickTimer);
				deps.onPaired();
				return;
			}
			// The next code starts its own loop; this one ends here.
			if (status === 'expired') return void begin();
			if (status === 'slow_down') intervalMs += SLOW_DOWN_MS;
			failed = false;
		}
		publish();
		pollTimer = deps.setTimeout(() => void poll(mine), intervalMs);
	}

	function tick() {
		now = deps.now();
		// The server would say "expired" too; this just avoids showing a dead code.
		if (started && started.expiresAt <= now && !failed) void begin();
		publish();
	}

	return {
		start() {
			stopped = false;
			void begin();
			tickTimer = deps.setInterval(tick, 1000);
		},
		/** Stops every timer and ignores answers still on their way. */
		stop() {
			stopped = true;
			loop++;
			deps.clearInterval(tickTimer);
			deps.clearTimeout(pollTimer);
			deps.clearTimeout(retryTimer);
		},
	};
}
