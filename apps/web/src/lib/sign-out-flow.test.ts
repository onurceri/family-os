import { describe, expect, it, vi } from 'vitest';
import { type SignOutSteps, signOutSafely } from './sign-out-flow.js';

function steps(over: Partial<SignOutSteps> & { waiting?: number[] } = {}) {
	const log: string[] = [];
	const waiting = over.waiting ?? [0];
	const all: SignOutSteps = {
		online: () => true,
		flush: async () => void log.push('flush'),
		waitingCount: () => waiting.shift() ?? 0,
		confirmDiscard: async () => {
			log.push('confirm');
			return true;
		},
		request: async () => void log.push('request'),
		clear: async () => void log.push('clear'),
		...over,
	};
	return { all, log };
}

describe('signing out with waiting changes', () => {
	it('sends waiting changes first and clears only after the sign-out succeeded', async () => {
		const { all, log } = steps();
		expect(await signOutSafely(all)).toBe('signed-out');
		expect(log).toEqual(['flush', 'request', 'clear']);
	});

	it('asks before discarding what could not be sent', async () => {
		const { all, log } = steps({ waiting: [2] });
		const confirmDiscard = vi.fn(all.confirmDiscard);
		await signOutSafely({ ...all, confirmDiscard });
		expect(confirmDiscard).toHaveBeenCalledWith(2);
		expect(log).toEqual(['flush', 'confirm', 'request', 'clear']);
	});

	it('does not try to send while offline, and still asks', async () => {
		const { all, log } = steps({ online: () => false, waiting: [1] });
		await signOutSafely(all);
		expect(log).toEqual(['confirm', 'request', 'clear']);
	});

	it('keeps everything when the person declines', async () => {
		const { all, log } = steps({ waiting: [1], confirmDiscard: async () => false });
		expect(await signOutSafely(all)).toBe('cancelled');
		expect(log).toEqual(['flush']);
	});

	it('keeps the queue when the sign-out request fails', async () => {
		const { all, log } = steps({
			waiting: [1],
			request: async () => {
				throw new Error('network');
			},
		});
		await expect(signOutSafely(all)).rejects.toThrow('network');
		expect(log).toEqual(['flush', 'confirm']);
	});
});
