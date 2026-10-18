import { describe, expect, it, vi } from 'vitest';
import { revealWhenRendered } from '../src/web/reveal.ts';

/** A frame clock the test advances by hand. */
function clock() {
	const queue: (() => void)[] = [];
	return {
		frame: (run: () => void) => void queue.push(run),
		tick: () => queue.shift()?.(),
		pending: () => queue.length,
	};
}

describe('revealWhenRendered', () => {
	it('waits for the row to be drawn, then brings it into view without covering it', () => {
		const frames = clock();
		const row = { scrollIntoView: vi.fn() };
		let drawn = false;
		revealWhenRendered({ find: () => (drawn ? row : null), frame: frames.frame, smooth: true });
		frames.tick();
		frames.tick();
		expect(row.scrollIntoView).not.toHaveBeenCalled();
		drawn = true;
		frames.tick();
		expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
		expect(frames.pending()).toBe(0);
	});

	it('does not animate when motion is reduced', () => {
		const frames = clock();
		const row = { scrollIntoView: vi.fn() };
		revealWhenRendered({ find: () => row, frame: frames.frame, smooth: false });
		frames.tick();
		expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
	});

	it('gives up quietly when the row never comes', () => {
		const frames = clock();
		revealWhenRendered({ find: () => null, frame: frames.frame, smooth: true, frames: 3 });
		for (let i = 0; i < 10; i++) frames.tick();
		expect(frames.pending()).toBe(0);
	});
});
