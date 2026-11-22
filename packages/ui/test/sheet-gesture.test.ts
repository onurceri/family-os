import { afterEach, describe, expect, it, vi } from 'vitest';
import { closesOnRelease, lockPageScroll, pullToClose } from '../src/famos/sheet-gesture.js';

afterEach(() => {
	document.body.innerHTML = '';
	document.documentElement.style.overflow = '';
});

function touch(target: Element, type: string, x: number, y: number, timeStamp: number): Event {
	const e = new Event(type, { bubbles: true, cancelable: true });
	const points = type === 'touchend' ? [] : [{ clientX: x, clientY: y }];
	Object.defineProperty(e, 'touches', { value: points });
	Object.defineProperty(e, 'timeStamp', { value: timeStamp });
	target.dispatchEvent(e);
	return e;
}

/** A finger moving from (x, y0) to (x, y1) in `steps` moves over `ms`. */
function drag(
	target: Element,
	y0: number,
	y1: number,
	{ x0 = 100, x1 = 100, ms = 400, steps = 8 } = {},
) {
	touch(target, 'touchstart', x0, y0, 0);
	const moves: Event[] = [];
	for (let i = 1; i <= steps; i++)
		moves.push(
			touch(
				target,
				'touchmove',
				x0 + ((x1 - x0) * i) / steps,
				y0 + ((y1 - y0) * i) / steps,
				(ms * i) / steps,
			),
		);
	touch(target, 'touchend', x1, y1, ms);
	return moves;
}

function sheet() {
	document.body.innerHTML =
		'<div id="sheet"><header id="bar">Title</header><div id="body"><p id="row">Row</p></div></div>';
	const el = document.getElementById('sheet') as HTMLElement;
	Object.defineProperty(el, 'offsetHeight', { value: 800 });
	return {
		el,
		bar: document.getElementById('bar') as HTMLElement,
		body: document.getElementById('body') as HTMLElement,
		row: document.getElementById('row') as HTMLElement,
	};
}

describe('closesOnRelease', () => {
	it('closes after a quarter of the sheet, at most 120 px', () => {
		expect(closesOnRelease(119, 0, 800)).toBe(false);
		expect(closesOnRelease(120, 0, 800)).toBe(true);
		expect(closesOnRelease(74, 0, 300)).toBe(false);
		expect(closesOnRelease(75, 0, 300)).toBe(true);
	});

	it('closes on a quick flick, but not a twitch or a move up', () => {
		expect(closesOnRelease(40, 0.8, 800)).toBe(true);
		expect(closesOnRelease(20, 0.8, 800)).toBe(false);
		expect(closesOnRelease(-200, 2, 800)).toBe(false);
	});
});

describe('pullToClose', () => {
	it('closes when the bar is pulled far enough, and stops the page from scrolling meanwhile', () => {
		const { el, bar } = sheet();
		const close = vi.fn();
		pullToClose(el, close);
		const moves = drag(bar, 50, 300);
		expect(close).toHaveBeenCalledOnce();
		expect(moves.at(-1)?.defaultPrevented).toBe(true);
		expect(el.style.transform).toBe('');
		expect(el.dataset.pulling).toBeUndefined();
	});

	it('moves the sheet with the finger and puts it back after a short pull', () => {
		const { el, bar } = sheet();
		const close = vi.fn();
		pullToClose(el, close);
		touch(bar, 'touchstart', 100, 50, 0);
		touch(bar, 'touchmove', 100, 60, 100);
		touch(bar, 'touchmove', 100, 90, 600);
		expect(el.style.transform).toBe('translateY(30px)');
		expect(el.dataset.pulling).toBe('');
		touch(bar, 'touchend', 100, 90, 1200);
		expect(close).not.toHaveBeenCalled();
		expect(el.style.transform).toBe('');
	});

	it('pulls from content that is at its top', () => {
		const { el, row } = sheet();
		const close = vi.fn();
		pullToClose(el, close);
		drag(row, 100, 400);
		expect(close).toHaveBeenCalledOnce();
	});

	it('leaves content that is scrolled down to scroll', () => {
		const { el, body, row } = sheet();
		Object.defineProperty(body, 'scrollTop', { value: 200 });
		const close = vi.fn();
		pullToClose(el, close);
		const moves = drag(row, 100, 400);
		expect(close).not.toHaveBeenCalled();
		expect(moves.some((m) => m.defaultPrevented)).toBe(false);
		expect(el.style.transform).toBe('');
	});

	it('ignores moves up and sideways', () => {
		const { el, row } = sheet();
		const close = vi.fn();
		pullToClose(el, close);
		const up = drag(row, 400, 100);
		const sideways = drag(row, 100, 160, { x1: 400 });
		expect(close).not.toHaveBeenCalled();
		expect([...up, ...sideways].some((m) => m.defaultPrevented)).toBe(false);
	});

	it('leaves a slider to the finger', () => {
		const { el, body } = sheet();
		body.insertAdjacentHTML('beforeend', '<input id="level" type="range" />');
		const close = vi.fn();
		pullToClose(el, close);
		drag(document.getElementById('level') as HTMLElement, 100, 400);
		expect(close).not.toHaveBeenCalled();
	});

	it('stops listening', () => {
		const { el, bar } = sheet();
		const close = vi.fn();
		pullToClose(el, close)();
		drag(bar, 50, 400);
		expect(close).not.toHaveBeenCalled();
	});
});

describe('lockPageScroll', () => {
	it('keeps the page still until the last sheet lets go, then puts it back as it was', () => {
		const root = document.documentElement;
		root.style.overflow = 'clip';
		const first = lockPageScroll();
		const second = lockPageScroll();
		expect(root.style.overflow).toBe('hidden');
		first();
		first();
		expect(root.style.overflow).toBe('hidden');
		second();
		expect(root.style.overflow).toBe('clip');
	});
});
