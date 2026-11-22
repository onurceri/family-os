/**
 * What makes a phone sheet behave like one: pulling it down closes it, and the page under it does
 * not scroll while it is open.
 */

/** How far a finger moves before the move counts as a pull or a scroll. */
export const PULL_START = 8;

/**
 * Whether a pull that ends `distance` px down, moving at `speed` px/ms, closes a sheet `height` px
 * tall: a quarter of the sheet (at most 120 px) or a quick flick down.
 */
export function closesOnRelease(distance: number, speed: number, height: number): boolean {
	if (distance <= 0) return false;
	return distance >= Math.min(120, height / 4) || (speed > 0.5 && distance > 24);
}

/**
 * Pull to close. A touch that starts on the bar, or in content scrolled to its top, and moves down
 * moves the sheet with the finger; letting go far or fast enough calls `close` (the page may still
 * keep the sheet, for example to ask about unsaved changes), otherwise the sheet goes back. A touch
 * in content that is scrolled down or on a slider, a sideways move, or one going up stays as it was.
 * While pulling the sheet carries `data-pulling`. Returns the function that stops listening.
 */
export function pullToClose(sheet: HTMLElement, close: () => void): () => void {
	let tracking = false;
	let pulling = false;
	let startX = 0;
	let startY = 0;
	let distance = 0;
	// The last two samples, for the speed at release.
	let lastY = 0;
	let lastT = 0;
	let prevY = 0;
	let prevT = 0;

	const scrolledDown = (target: EventTarget | null) => {
		for (
			let el = target instanceof Element ? target : null;
			el && el !== sheet;
			el = el.parentElement
		)
			if (el.scrollTop > 0) return true;
		return false;
	};
	// A slider takes the finger itself, even when it slips down a little.
	const ownsTouch = (target: EventTarget | null) =>
		target instanceof Element && target.closest('input[type="range"]') !== null;

	const settle = () => {
		pulling = false;
		tracking = false;
		distance = 0;
		delete sheet.dataset.pulling;
		sheet.style.transform = '';
	};

	const onstart = (e: TouchEvent) => {
		const t = e.touches[0];
		tracking =
			e.touches.length === 1 && t !== undefined && !scrolledDown(e.target) && !ownsTouch(e.target);
		pulling = false;
		if (!tracking || !t) return;
		startX = t.clientX;
		startY = t.clientY;
	};

	const onmove = (e: TouchEvent) => {
		const t = e.touches[0];
		if (!tracking || !t) return;
		const dy = t.clientY - startY;
		if (!pulling) {
			const dx = t.clientX - startX;
			if (Math.abs(dy) < PULL_START && Math.abs(dx) < PULL_START) {
				// Downward from the top nothing can scroll; claimed now so the browser does not start
				// its own bounce before the pull begins.
				if (dy > 0 && dy >= Math.abs(dx) && e.cancelable) e.preventDefault();
				return;
			}
			if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
				tracking = false;
				return;
			}
			pulling = true;
			startY = t.clientY;
			prevY = lastY = t.clientY;
			prevT = lastT = e.timeStamp;
			sheet.dataset.pulling = '';
		}
		if (e.cancelable) e.preventDefault();
		prevY = lastY;
		prevT = lastT;
		lastY = t.clientY;
		lastT = e.timeStamp;
		distance = Math.max(0, t.clientY - startY);
		sheet.style.transform = `translateY(${distance}px)`;
	};

	const onend = () => {
		if (!pulling) {
			tracking = false;
			return;
		}
		const speed = lastT > prevT ? (lastY - prevY) / (lastT - prevT) : 0;
		const shut = closesOnRelease(distance, speed, sheet.offsetHeight);
		settle();
		if (shut) close();
	};

	// Not passive: a pull has to stop the page's own scroll.
	sheet.addEventListener('touchstart', onstart, { passive: true });
	sheet.addEventListener('touchmove', onmove, { passive: false });
	sheet.addEventListener('touchend', onend);
	sheet.addEventListener('touchcancel', settle);
	return () => {
		sheet.removeEventListener('touchstart', onstart);
		sheet.removeEventListener('touchmove', onmove);
		sheet.removeEventListener('touchend', onend);
		sheet.removeEventListener('touchcancel', settle);
		settle();
	};
}

const locks = new WeakMap<Document, { count: number; overflow: string }>();

/**
 * Keeps the page from scrolling under a sheet. Sheets can open over each other, so the page
 * scrolls again only when the last one lets go. Returns the function that lets go (once).
 */
export function lockPageScroll(doc: Document = document): () => void {
	const root = doc.documentElement;
	const lock = locks.get(doc) ?? { count: 0, overflow: root.style.overflow };
	if (lock.count === 0) {
		lock.overflow = root.style.overflow;
		root.style.overflow = 'hidden';
	}
	lock.count++;
	locks.set(doc, lock);
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		lock.count--;
		if (lock.count === 0) root.style.overflow = lock.overflow;
	};
}
