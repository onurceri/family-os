import { describe, expect, it } from 'vitest';
import { offersDeviceCover } from './device-cover.js';

describe('the cover for when nobody is using the app', () => {
	it('is offered on a family device whose slideshow is on', () => {
		expect(offersDeviceCover({ device: { slideshow: true } })).toBe(true);
	});

	it('is not offered on a family device where it was turned off', () => {
		expect(offersDeviceCover({ device: { slideshow: false } })).toBe(false);
	});

	it('is never offered on a personal device, or before anyone is signed in', () => {
		expect(offersDeviceCover({ device: null })).toBe(false);
		expect(offersDeviceCover(null)).toBe(false);
		expect(offersDeviceCover(undefined)).toBe(false);
	});

	it('goes away when the session ends or the device is removed (me becomes null)', () => {
		// The shell mounts the `device.ambient` slot only while this is true, so the cover unmounts
		// with the person and the sign-in page is what remains.
		let me: { device: { slideshow: boolean } | null } | null = { device: { slideshow: true } };
		expect(offersDeviceCover(me)).toBe(true);
		me = null;
		expect(offersDeviceCover(me)).toBe(false);
	});
});
