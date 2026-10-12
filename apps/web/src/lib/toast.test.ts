import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_MS, HoldableTimer, PLAIN_MS } from './toast-timer.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const run = (ms: number) => {
	const timer = new HoldableTimer();
	const done = vi.fn();
	timer.start(ms, done);
	return { timer, done };
};

describe('toast durations', () => {
	it('keeps a notice with an action longer than a plain one', () => {
		expect(ACTION_MS).toBeGreaterThanOrEqual(10000);
		expect(ACTION_MS).toBeGreaterThan(PLAIN_MS);
	});
});

describe('HoldableTimer', () => {
	it('finishes after its time', () => {
		const { done } = run(5000);
		vi.advanceTimersByTime(4900);
		expect(done).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(done).toHaveBeenCalledOnce();
	});

	it('waits while held and runs on after release', () => {
		const { timer, done } = run(10000);
		vi.advanceTimersByTime(8000);
		timer.hold();
		vi.advanceTimersByTime(60000);
		expect(done).not.toHaveBeenCalled();
		timer.release();
		vi.advanceTimersByTime(1900);
		expect(done).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(done).toHaveBeenCalledOnce();
	});

	it('does not finish after cancel', () => {
		const { timer, done } = run(1000);
		timer.cancel();
		vi.advanceTimersByTime(5000);
		expect(done).not.toHaveBeenCalled();
	});
});
