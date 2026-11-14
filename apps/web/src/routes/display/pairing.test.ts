import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Answer, createPairing, type PollStatus, type Started } from './pairing.js';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const code = (n: number, expiresAt: number): Started => ({
	deviceCode: `device-${n}`,
	userCode: `CODE-${n}`,
	expiresAt,
	interval: 5,
});

function setup() {
	const mints: Deferred<Answer<Started>>[] = [];
	const polls: { deviceCode: string; answer: Deferred<Answer<{ status: PollStatus }>> }[] = [];
	const paired = vi.fn();
	const pairing = createPairing({
		mint: () => {
			const d = deferred<Answer<Started>>();
			mints.push(d);
			return d.promise;
		},
		poll: (deviceCode) => {
			const answer = deferred<Answer<{ status: PollStatus }>>();
			polls.push({ deviceCode, answer });
			return answer.promise;
		},
		now: () => Date.now(),
		setTimeout: (run, ms) => setTimeout(run, ms),
		clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
		setInterval: (run, ms) => setInterval(run, ms),
		clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
		onChange: () => {},
		onPaired: paired,
	});
	return { pairing, mints, polls, paired };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('pairing', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => vi.useRealTimers());

	it('a slow mint near expiry mints once', async () => {
		const { pairing, mints } = setup();
		pairing.start();
		mints[0]?.resolve({ ok: true, data: code(1, 1_003_000) });
		await flush();
		// The code expires while the POST for the next one is still unanswered.
		await vi.advanceTimersByTimeAsync(3000);
		expect(mints).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mints).toHaveLength(2);
		pairing.stop();
	});

	it('expired from a poll while a mint is in flight does not start a second mint', async () => {
		const { pairing, mints, polls } = setup();
		pairing.start();
		mints[0]?.resolve({ ok: true, data: code(1, 1_004_000) });
		await flush();
		await vi.advanceTimersByTimeAsync(4000);
		// The tick has started a mint; the poll that was due answers "expired" meanwhile.
		expect(mints).toHaveLength(2);
		polls[0]?.answer.resolve({ ok: true, data: { status: 'expired' } });
		await flush();
		expect(mints).toHaveLength(2);
		mints[1]?.resolve({ ok: true, data: code(2, 1_300_000) });
		await flush();
		// Exactly one live loop polls the new code.
		await vi.advanceTimersByTimeAsync(5000);
		expect(polls.filter((p) => p.deviceCode === 'device-2')).toHaveLength(1);
		pairing.stop();
	});

	it('an old loop answering after a newer code is ignored', async () => {
		const { pairing, mints, polls, paired } = setup();
		pairing.start();
		mints[0]?.resolve({ ok: true, data: code(1, 1_004_000) });
		await flush();
		await vi.advanceTimersByTimeAsync(4000);
		mints[1]?.resolve({ ok: true, data: code(2, 1_300_000) });
		await flush();
		const before = polls.length;
		polls[0]?.answer.resolve({ ok: true, data: { status: 'paired' } });
		await flush();
		expect(paired).not.toHaveBeenCalled();
		// Nothing was scheduled by the old loop: only the new code's loop polls.
		await vi.advanceTimersByTimeAsync(5000);
		expect(polls.slice(before).every((p) => p.deviceCode === 'device-2')).toBe(true);
		expect(polls.length - before).toBe(1);
		pairing.stop();
	});

	it('pairing hands over once and stops polling', async () => {
		const { pairing, mints, polls, paired } = setup();
		pairing.start();
		mints[0]?.resolve({ ok: true, data: code(1, 1_300_000) });
		await flush();
		await vi.advanceTimersByTimeAsync(5000);
		polls[0]?.answer.resolve({ ok: true, data: { status: 'paired' } });
		await flush();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(paired).toHaveBeenCalledTimes(1);
		expect(polls).toHaveLength(1);
	});

	it('a failed mint is retried after a wait, once', async () => {
		const { pairing, mints } = setup();
		pairing.start();
		mints[0]?.resolve({ ok: false });
		await flush();
		await vi.advanceTimersByTimeAsync(14_000);
		expect(mints).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(mints).toHaveLength(2);
		pairing.stop();
	});

	it('stop ends every timer and ignores answers on their way', async () => {
		const { pairing, mints, polls, paired } = setup();
		pairing.start();
		mints[0]?.resolve({ ok: true, data: code(1, 1_300_000) });
		await flush();
		await vi.advanceTimersByTimeAsync(5000);
		pairing.stop();
		polls[0]?.answer.resolve({ ok: true, data: { status: 'paired' } });
		await flush();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(paired).not.toHaveBeenCalled();
		expect(polls).toHaveLength(1);
		expect(mints).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
