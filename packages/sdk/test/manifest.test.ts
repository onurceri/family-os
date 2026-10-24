import { describe, expect, it } from 'vitest';
import { compareVersions } from '../src/index.ts';

describe('compareVersions', () => {
	const sign = (a: string, b: string) => Math.sign(compareVersions(a, b));

	it('orders by number, not by text', () => {
		expect(sign('1.10.0', '1.9.0')).toBe(1);
		expect(sign('0.8.2', '0.8.10')).toBe(-1);
		expect(sign('2.0.0', '1.99.99')).toBe(1);
		expect(sign('1.2.3', '1.2.3')).toBe(0);
	});

	it('counts a missing part as zero', () => {
		expect(sign('1.2', '1.2.0')).toBe(0);
		expect(sign('1', '1.0.1')).toBe(-1);
	});

	it('puts a pre-release before its release and orders pre-releases', () => {
		expect(sign('1.2.3-rc1', '1.2.3')).toBe(-1);
		expect(sign('1.2.3', '1.2.3-rc1')).toBe(1);
		expect(sign('1.2.3-rc1', '1.2.2')).toBe(1);
		expect(sign('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
		expect(sign('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
		expect(sign('1.0.0-1', '1.0.0-alpha')).toBe(-1);
		expect(sign('1.0.0-beta', '1.0.0-alpha')).toBe(1);
	});

	it('never returns NaN: text that is not a version is older than any version', () => {
		expect(sign('latest', '0.0.1')).toBe(-1);
		expect(sign('0.0.1', 'latest')).toBe(1);
		expect(sign('latest', 'next')).toBe(0);
	});
});
