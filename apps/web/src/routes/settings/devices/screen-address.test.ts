import { describe, expect, it } from 'vitest';
import { isLoopbackHost, screenAddress } from './screen-address.js';

describe('isLoopbackHost', () => {
	it.each([
		'localhost',
		'LOCALHOST',
		'kitchen.localhost',
		'127.0.0.1',
		'127.1.2.3',
		'[::1]',
		'::1',
		'0.0.0.0',
	])('%s only reaches this computer', (host) => expect(isLoopbackHost(host)).toBe(true));
	it.each(['192.168.1.20', 'famos.local', 'family.example.com', '10.0.0.5', '1270.0.0.1'])(
		'%s can be reached from another device',
		(host) => expect(isLoopbackHost(host)).toBe(false),
	);
});

describe('screenAddress', () => {
	it('uses the address the admin opened when it can be reached', () => {
		expect(screenAddress('http://192.168.1.20:3000', null)).toEqual({
			url: 'http://192.168.1.20:3000',
			loopback: false,
		});
	});
	it('offers no address for a loopback origin without a family address', () => {
		expect(screenAddress('http://localhost:3500', null)).toEqual({ url: null, loopback: true });
		expect(screenAddress('http://127.0.0.1:3500', 'http://localhost:3500')).toEqual({
			url: null,
			loopback: true,
		});
	});
	it('uses the configured family address instead of a loopback origin', () => {
		expect(screenAddress('http://localhost:3500', 'https://famos.example')).toEqual({
			url: 'https://famos.example',
			loopback: true,
		});
	});
	it('ignores the configured address when the admin is already on a real one', () => {
		expect(screenAddress('http://192.168.1.20:3000', 'https://famos.example').url).toBe(
			'http://192.168.1.20:3000',
		);
	});
});
