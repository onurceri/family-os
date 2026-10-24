import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NowProbe from './fixtures/NowProbe.svelte';

describe('useNow', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-24T10:00:00Z'));
	});
	afterEach(() => {
		document.body.innerHTML = '';
		vi.useRealTimers();
	});

	it('moves on every interval and stops when the component goes away', () => {
		const component = mount(NowProbe, { target: document.body });
		flushSync();
		const first = Number(document.body.textContent);
		vi.advanceTimersByTime(30_000);
		flushSync();
		expect(Number(document.body.textContent)).toBe(first + 30_000);
		unmount(component);
		expect(vi.getTimerCount()).toBe(0);
	});
});
