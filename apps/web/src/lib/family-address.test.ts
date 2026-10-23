import { describe, expect, it } from 'vitest';
import { familyAddress } from './family-address';

describe('familyAddress', () => {
	it('prefers the configured address over the one in the browser', () => {
		expect(familyAddress('https://family.example', 'http://localhost:3000')).toBe(
			'https://family.example',
		);
	});

	it('falls back to the browser address when none is configured', () => {
		expect(familyAddress(null, 'http://192.168.1.5:3000')).toBe('http://192.168.1.5:3000');
	});

	it('drops a trailing slash', () => {
		expect(familyAddress('https://family.example/', '')).toBe('https://family.example');
	});
});
