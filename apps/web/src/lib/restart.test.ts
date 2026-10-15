import { describe, expect, it } from 'vitest';
import { extensionsChanged, readBoot, waitForRestart } from './restart.js';

/** A clock that moves only when the wait sleeps. */
function clock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

const answers = (...boots: (string | null)[]) => {
	let i = 0;
	const asked: number[] = [];
	return {
		asked,
		read: async () => {
			asked.push(i);
			return boots[Math.min(i++, boots.length - 1)] ?? null;
		},
	};
};

describe('waiting for the restart', () => {
	it('waits until the server answers with another start id', async () => {
		const server = answers('a', 'a', null, null, 'b');
		expect(await waitForRestart({ before: 'a', ...server, ...clock() })).toBe('restarted');
		expect(server.asked).toHaveLength(5);
	});

	it('takes a server that was down and answers again as restarted when the id was not known', async () => {
		const server = answers('x', null, 'x');
		expect(await waitForRestart({ before: null, ...server, ...clock() })).toBe('restarted');
		expect(server.asked).toHaveLength(3);
	});

	it('gives up after the timeout, and stops when the page is left', async () => {
		expect(
			await waitForRestart({ before: 'a', ...answers('a'), ...clock(), timeoutMs: 5000 }),
		).toBe('timeout');
		const left = new AbortController();
		left.abort();
		expect(
			await waitForRestart({ before: 'a', ...answers('a'), ...clock(), signal: left.signal }),
		).toBe('aborted');
	});

	it('reads the start id, and null while the server does not answer', async () => {
		const ok = async () => new Response(JSON.stringify({ status: 'ok', boot: 'b1' }));
		expect(await readBoot(ok as typeof fetch)).toBe('b1');
		const down = async () => {
			throw new TypeError('Failed to fetch');
		};
		expect(await readBoot(down as typeof fetch)).toBeNull();
		const starting = async () => new Response('', { status: 503 });
		expect(await readBoot(starting as typeof fetch)).toBeNull();
	});
});

describe('noticing other extensions', () => {
	it('compares the fingerprints only when both are known', () => {
		expect(extensionsChanged('f1', 'f2')).toBe(true);
		expect(extensionsChanged('f1', 'f1')).toBe(false);
		expect(extensionsChanged('', 'f2')).toBe(false);
		expect(extensionsChanged('f1', undefined)).toBe(false);
		expect(extensionsChanged('f1', '')).toBe(false);
	});
});
