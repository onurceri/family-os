import { describe, expect, it } from 'vitest';
import { addressKey, createRateLimiter } from '../src/http/rate-limit.ts';

describe('addressKey', () => {
	it('counts every address of an IPv6 /64 as one, however it is written', () => {
		const key = addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
		expect(addressKey('2001:db8:1:2::1')).toBe(key);
		expect(addressKey('2001:0DB8:0001:0002:0:0:0:ffff')).toBe(key);
		expect(addressKey('2001:db8:1:3::1')).not.toBe(key);
		expect(addressKey('::1')).toBe('0:0:0:0::/64');
	});

	it('leaves IPv4 addresses and other keys alone', () => {
		expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
		expect(addressKey('member_123')).toBe('member_123');
	});
});

describe('createRateLimiter', () => {
	it('limits an IPv6 subscriber as a whole, not per address', () => {
		const limit = createRateLimiter({ max: 2, windowMs: 1000 });
		expect(limit.hit('2001:db8:1:2::1')).toBe(true);
		expect(limit.hit('2001:db8:1:2::2')).toBe(true);
		expect(limit.hit('2001:db8:1:2::3')).toBe(false);
		expect(limit.hit('2001:db8:1:9::1')).toBe(true);
	});

	it('caps the keys it remembers, forgetting the oldest first', () => {
		let at = 0;
		const limit = createRateLimiter({ max: 1, windowMs: 1_000_000, now: () => at });
		for (let i = 0; i < 5000; i++) {
			at = i;
			limit.hit(`k${i}`);
		}
		expect(limit.size()).toBe(5000);
		at = 5000;
		limit.hit('newest');
		expect(limit.size()).toBe(5000);
		// The oldest was forgotten (it counts as new again); a recent one is still counted.
		expect(limit.hit('k0')).toBe(true);
		expect(limit.hit('k4999')).toBe(false);
	});

	it('drops expired windows before evicting live ones', () => {
		let at = 0;
		const limit = createRateLimiter({ max: 1, windowMs: 100, now: () => at });
		for (let i = 0; i < 5000; i++) limit.hit(`k${i}`);
		at = 200;
		limit.hit('fresh');
		expect(limit.size()).toBe(1);
	});
});
