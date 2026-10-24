import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@famos/ui/famos', () => ({ forgetSharedReads: () => {} }));

class FakeSocket {
	static all: FakeSocket[] = [];
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((m: { data: string }) => void) | null = null;
	closed = false;
	constructor(readonly url: string) {
		FakeSocket.all.push(this);
	}
	/** The connection drops by itself. */
	drop() {
		this.closed = true;
		this.onclose?.();
	}
	close() {
		this.closed = true;
		this.onclose?.();
	}
}
const live = () => FakeSocket.all.filter((s) => !s.closed);

let realtime: typeof import('./realtime.js');

beforeEach(async () => {
	vi.useFakeTimers();
	FakeSocket.all = [];
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal('location', { protocol: 'http:', host: 'x.test' });
	vi.resetModules();
	realtime = await import('./realtime.js');
});

afterEach(() => {
	realtime.disconnectRealtime();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('realtime', () => {
	it('does not reopen after a disconnect during the wait before a reconnect', () => {
		realtime.connectRealtime();
		FakeSocket.all[0]?.drop();
		realtime.disconnectRealtime();
		vi.advanceTimersByTime(60_000);
		expect(FakeSocket.all).toHaveLength(1);
	});

	it('has one socket after a disconnect and a connect inside the wait', () => {
		realtime.connectRealtime();
		FakeSocket.all[0]?.drop();
		realtime.disconnectRealtime();
		realtime.connectRealtime();
		vi.advanceTimersByTime(60_000);
		expect(live()).toHaveLength(1);
	});

	it('connecting twice opens one socket', () => {
		realtime.connectRealtime();
		realtime.disconnectRealtime();
		realtime.connectRealtime();
		realtime.connectRealtime();
		expect(live()).toHaveLength(1);
	});

	it('reconnects after the socket drops', () => {
		realtime.connectRealtime();
		FakeSocket.all[0]?.drop();
		vi.advanceTimersByTime(1000);
		expect(FakeSocket.all).toHaveLength(2);
	});
});
