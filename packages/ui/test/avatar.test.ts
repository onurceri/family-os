import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar } from '../src/famos/index.js';
import { cleanup, render } from './helpers.js';

afterEach(cleanup);

describe('Avatar', () => {
	it('shows the initial on the member color without a photo', () => {
		const el = render(Avatar, { name: 'Mara', color: '#336699', size: 36 });
		expect(el.querySelector('img')).toBeNull();
		expect(el.textContent?.trim()).toBe('M');
	});

	it('shows the photo inside a ring of the member color', () => {
		const el = render(Avatar, { name: 'Mara', color: '#336699', size: 36, photo: '/p.jpg' });
		const img = el.querySelector('img') as HTMLImageElement;
		expect(img.getAttribute('src')).toBe('/p.jpg');
		expect(img.getAttribute('alt')).toBe('');
		expect(img.getAttribute('loading')).toBe('lazy');
		const ring = el.querySelector('[data-testid="photo-avatar"]') as HTMLElement;
		expect(ring.style.border).toContain('2px solid');
		expect(ring.style.borderColor).toBe('#336699');
		expect(ring.style.width).toBe('36px');
		expect(el.textContent?.trim()).toBe('');
	});

	it('draws a thinner ring on small avatars', () => {
		const el = render(Avatar, { name: 'Mara', color: '#336699', size: 18, photo: '/p.jpg' });
		const ring = el.querySelector('[data-testid="photo-avatar"]') as HTMLElement;
		expect(ring.style.border).toContain('1px solid');
	});

	it('draws no ring of its own where one is already drawn around it', () => {
		const el = render(Avatar, { name: 'Mara', color: '#336699', photo: '/p.jpg', ring: false });
		const ring = el.querySelector('[data-testid="photo-avatar"]') as HTMLElement;
		expect(ring.style.border).toContain('0px');
	});

	it('falls back to the initial when the photo does not load', () => {
		const el = render(Avatar, { name: 'Mara', color: '#336699', photo: '/gone.jpg' });
		(el.querySelector('img') as HTMLImageElement).dispatchEvent(new Event('error'));
		flushSync();
		expect(el.querySelector('img')).toBeNull();
		expect(el.textContent?.trim()).toBe('M');
	});

	it('keeps the neutral icon for anyone, whatever photo is passed', () => {
		const el = render(Avatar, { name: 'Anyone', color: '', anyone: true, photo: '/p.jpg' });
		expect(el.querySelector('img')).toBeNull();
		expect(el.querySelector('[data-testid="anyone-avatar"]')).not.toBeNull();
	});
});
