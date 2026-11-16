import { afterEach, describe, expect, it } from 'vitest';
import { inertBeneath, overlayOpen } from '../src/famos/overlay.js';

afterEach(() => {
	document.body.innerHTML = '';
});

describe('overlayOpen', () => {
	it('is false on a plain page and for a dialog that is not open', () => {
		document.body.innerHTML = '<main>page</main><dialog>closed</dialog>';
		expect(overlayOpen()).toBe(false);
	});

	it('is true while a native dialog is open', () => {
		document.body.innerHTML = '<main>page</main><dialog open>asking</dialog>';
		expect(overlayOpen()).toBe(true);
	});

	it('is true while a side panel or a sheet is open', () => {
		document.body.innerHTML = '<main>page</main><div role="dialog" aria-modal="false">panel</div>';
		expect(overlayOpen()).toBe(true);
	});
});

describe('inertBeneath', () => {
	it('makes the rest of the page inert and gives it back as it was', () => {
		document.body.innerHTML =
			'<div id="app"><nav id="nav"></nav><main id="main"></main><section id="cover"></section></div><div id="toast"></div>';
		document.getElementById('main')?.setAttribute('inert', '');
		const cover = document.getElementById('cover') as HTMLElement;
		const restore = inertBeneath(cover);
		for (const id of ['nav', 'main', 'toast'])
			expect(document.getElementById(id)?.hasAttribute('inert')).toBe(true);
		expect(cover.hasAttribute('inert')).toBe(false);
		expect(document.getElementById('app')?.hasAttribute('inert')).toBe(false);
		restore();
		expect(document.getElementById('nav')?.hasAttribute('inert')).toBe(false);
		expect(document.getElementById('toast')?.hasAttribute('inert')).toBe(false);
		// What was inert before stays inert.
		expect(document.getElementById('main')?.hasAttribute('inert')).toBe(true);
	});
});
