import { describe, expect, it } from 'vitest';
import {
	goTo,
	type RotationConfig,
	type RotationState,
	startRotation,
	step,
	tick,
	touch,
} from './rotation.js';

const config: RotationConfig = { todaySeconds: 120, pageSeconds: 30, backSeconds: 90 };
const s = (n: number) => n * 1000;

describe('rotation', () => {
	it('starts on Today', () => {
		expect(startRotation(5)).toEqual({ index: 0, since: 5, pausedUntil: null });
	});

	it('stays on Today for its time, then shows the first page', () => {
		const start = startRotation(0);
		expect(tick(start, s(119), config, 2)).toBe(start);
		expect(tick(start, s(120), config, 2)).toEqual({ index: 1, since: s(120), pausedUntil: null });
	});

	it('shows each page for the page time, then comes back to Today and starts again', () => {
		let state: RotationState = startRotation(0);
		state = tick(state, s(120), config, 2);
		expect(state.index).toBe(1);
		expect(tick(state, s(149), config, 2)).toBe(state);
		state = tick(state, s(150), config, 2);
		expect(state).toEqual({ index: 2, since: s(150), pausedUntil: null });
		state = tick(state, s(180), config, 2);
		expect(state).toEqual({ index: 0, since: s(180), pausedUntil: null });
		// Today's own time applies again.
		expect(tick(state, s(299), config, 2).index).toBe(0);
		expect(tick(state, s(300), config, 2).index).toBe(1);
	});

	it('is always Today with no pages', () => {
		const start = startRotation(0);
		expect(tick(start, s(10_000), config, 0)).toBe(start);
		// Even from a page, once its pages are gone.
		expect(tick({ index: 2, since: 0, pausedUntil: null }, s(1), config, 0)).toEqual(
			startRotation(s(1)),
		);
		expect(tick({ index: 0, since: 0, pausedUntil: s(50) }, s(1), config, 0)).toEqual(
			startRotation(s(1)),
		);
	});

	it('goes to Today when the pages shrink below the screen showing', () => {
		const state: RotationState = { index: 3, since: s(100), pausedUntil: null };
		expect(tick(state, s(105), config, 3)).toBe(state);
		expect(tick(state, s(105), config, 2)).toEqual(startRotation(s(105)));
		// Also while held after a touch.
		const held: RotationState = { index: 3, since: s(100), pausedUntil: s(500) };
		expect(tick(held, s(105), config, 1)).toEqual(startRotation(s(105)));
	});

	it('holds the screen after a touch for the back time, however long it has been there', () => {
		const onPage: RotationState = { index: 1, since: 0, pausedUntil: null };
		const held = touch(onPage, s(20), config);
		expect(held).toEqual({ index: 1, since: 0, pausedUntil: s(110) });
		// Past the page time, still held.
		expect(tick(held, s(100), config, 2)).toBe(held);
		expect(tick(held, s(109), config, 2)).toBe(held);
	});

	it('goes back to Today, from the start, when the hold ends', () => {
		const held: RotationState = { index: 2, since: 0, pausedUntil: s(110) };
		expect(tick(held, s(110), config, 2)).toEqual({ index: 0, since: s(110), pausedUntil: null });
	});

	it('a touch while held holds again from then on', () => {
		const held = touch({ index: 1, since: 0, pausedUntil: s(110) }, s(100), config);
		expect(held.pausedUntil).toBe(s(190));
		expect(tick(held, s(150), config, 2)).toBe(held);
	});

	it('a touch on Today holds Today, then Today starts again', () => {
		const held = touch(startRotation(0), s(10), config);
		expect(tick(held, s(60), config, 2)).toBe(held);
		expect(tick(held, s(100), config, 2)).toEqual(startRotation(s(100)));
	});

	it('goTo shows that screen and holds it', () => {
		expect(goTo(2, s(7), config)).toEqual({ index: 2, since: s(7), pausedUntil: s(97) });
	});

	it('steps to the next and previous screen, wrapping round, and holds', () => {
		const at = (index: number): RotationState => ({ index, since: 0, pausedUntil: null });
		expect(step(at(0), 1, s(1), config, 2).index).toBe(1);
		expect(step(at(2), 1, s(1), config, 2).index).toBe(0);
		expect(step(at(0), -1, s(1), config, 2).index).toBe(2);
		expect(step(at(1), -1, s(1), config, 2)).toEqual({ index: 0, since: s(1), pausedUntil: s(91) });
		// Nothing to step to.
		const only = at(0);
		expect(step(only, 1, s(1), config, 0)).toBe(only);
	});
});
