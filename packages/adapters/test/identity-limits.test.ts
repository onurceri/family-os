import { describe, expect, it } from 'vitest';
import { addressKey } from '../src/identity-betterauth/address.ts';
import { createAddressLimit, createLockout } from '../src/identity-betterauth/limits.ts';

describe('sign-in limits', () => {
	it('counts an IPv6 address as its /64 and keeps IPv4 as is', () => {
		expect(addressKey('2001:db8:1:2::1')).toBe(addressKey('2001:DB8:1:2:a:b:c:d'));
		expect(addressKey('2001:db8:1:3::1')).not.toBe(addressKey('2001:db8:1:2::1'));
		expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
	});

	it('locks after the count, for the time, and a success clears it', () => {
		let now = 0;
		const lock = createLockout({ after: 3, lockMs: 1000, now: () => now });
		lock.record('a', false);
		lock.record('a', false);
		lock.record('a', true);
		lock.record('a', false);
		lock.record('a', false);
		expect(lock.lockedFor('a')).toBe(0);
		lock.record('a', false);
		expect(lock.lockedFor('a')).toBe(1000);
		now = 1000;
		expect(lock.lockedFor('a')).toBe(0);
	});

	it('takes back one counted failure', () => {
		const lock = createLockout({ after: 2, lockMs: 1000, now: () => 0 });
		lock.record('a', false);
		lock.forgive('a');
		lock.record('a', false);
		expect(lock.lockedFor('a')).toBe(0);
		const limit = createAddressLimit({ max: 1, windowMs: 1000, now: () => 0 });
		limit.fail('a');
		limit.forgive('a');
		expect(limit.waitFor('a')).toBe(0);
		expect(limit.size()).toBe(0);
	});

	it('forgets failures older than its window', () => {
		let now = 0;
		const lock = createLockout({ after: 2, lockMs: 1000, windowMs: 100, now: () => now });
		lock.record('a', false);
		now = 100;
		lock.record('a', false);
		expect(lock.lockedFor('a')).toBe(0);
		lock.record('a', false);
		expect(lock.lockedFor('a')).toBe(1000);
	});

	it('remembers at most its cap of keys, dropping the oldest first', () => {
		const now = () => 0;
		const lock = createLockout({ after: 1, lockMs: 1000, now, maxKeys: 3 });
		for (const key of ['a', 'b', 'c', 'd']) lock.record(key, false);
		expect(lock.size()).toBe(3);
		expect(lock.lockedFor('a')).toBe(0);
		expect(lock.lockedFor('d')).toBe(1000);

		const limit = createAddressLimit({ max: 1, windowMs: 1000, now, maxKeys: 2 });
		for (const key of ['a', 'b', 'c']) limit.fail(key);
		expect(limit.size()).toBe(2);
		expect(limit.waitFor('a')).toBe(0);
		expect(limit.waitFor('c')).toBe(1000);
	});

	it('defaults to a cap of ten thousand keys', () => {
		const lock = createLockout({ after: 5, lockMs: 1000, now: () => 0 });
		for (let i = 0; i < 10_050; i++) lock.record(`2001:db8:${i.toString(16)}::/64`, false);
		expect(lock.size()).toBe(10_000);
	});
});
