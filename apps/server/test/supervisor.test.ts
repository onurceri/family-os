import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { RESTART_EXIT_CODE, type SupervisedChild, supervise } from '../src/supervisor.ts';

/** A scripted server: each start exits as told, after the given time on the fake clock. */
function harness(exits: { code: number | null; signal?: NodeJS.Signals; after?: number }[]) {
	let now = 0;
	const starts: number[] = [];
	const waits: number[] = [];
	const kills: NodeJS.Signals[] = [];
	const log: string[] = [];
	let signal: ((s: NodeJS.Signals) => void) | undefined;
	let current: EventEmitter | undefined;
	const deps = {
		start(): SupervisedChild {
			starts.push(now);
			const child = new EventEmitter();
			current = child;
			const next = exits.shift();
			if (next)
				queueMicrotask(() => {
					now += next.after ?? 60_000;
					child.emit('exit', next.code, next.signal ?? null);
				});
			return {
				once: (event, listener) => void child.once(event, listener),
				kill: (s) => {
					kills.push(s);
					queueMicrotask(() => child.emit('exit', null, s));
				},
			};
		},
		now: () => now,
		wait: async (ms: number) => {
			waits.push(ms);
			now += ms;
		},
		onSignal: (handler: (s: NodeJS.Signals) => void) => {
			signal = handler;
		},
		log: (message: string) => void log.push(message),
	};
	return {
		deps,
		starts,
		waits,
		kills,
		log,
		signal: (s: NodeJS.Signals) => signal?.(s),
		running: () => current,
	};
}

describe('the supervisor', () => {
	it('passes a normal exit through', async () => {
		const h = harness([{ code: 0 }]);
		expect(await supervise(h.deps)).toBe(0);
		expect(h.starts).toHaveLength(1);
	});

	it('passes any other exit code through without starting again', async () => {
		const h = harness([{ code: 1 }]);
		expect(await supervise(h.deps)).toBe(1);
		expect(h.starts).toHaveLength(1);
	});

	it('starts the server again, at once, when it asks to after running a while', async () => {
		const h = harness([{ code: RESTART_EXIT_CODE }, { code: RESTART_EXIT_CODE }, { code: 0 }]);
		expect(await supervise(h.deps)).toBe(0);
		expect(h.starts).toHaveLength(3);
		expect(h.waits).toEqual([]);
	});

	it('waits longer and longer while restarts keep coming quickly', async () => {
		const quick = { code: RESTART_EXIT_CODE, after: 100 };
		const h = harness([quick, quick, quick, quick, quick, quick, quick, { code: 3 }]);
		expect(await supervise(h.deps)).toBe(3);
		expect(h.waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
	});

	it('forgets the back-off once a start stays up', async () => {
		const quick = { code: RESTART_EXIT_CODE, after: 100 };
		const h = harness([
			quick,
			quick,
			{ code: RESTART_EXIT_CODE, after: 60_000 },
			quick,
			{ code: 0 },
		]);
		await supervise(h.deps);
		expect(h.waits).toEqual([1000, 2000, 1000]);
	});

	it('passes a signal on and does not start again after it', async () => {
		const h = harness([]);
		const done = supervise(h.deps);
		await new Promise((r) => setTimeout(r, 0));
		h.signal('SIGTERM');
		expect(await done).toBe(143);
		expect(h.kills).toEqual(['SIGTERM']);
		expect(h.starts).toHaveLength(1);
	});

	it('reports a server killed by a signal the way a shell does', async () => {
		const h = harness([{ code: null, signal: 'SIGKILL' }]);
		expect(await supervise(h.deps)).toBe(137);
	});
});
