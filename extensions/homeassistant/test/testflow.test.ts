import { describe, expect, it } from 'vitest';
import { formStep, testKey } from '../src/web/testflow.ts';

const ok = { status: 'ok', version: '2026.10.2', name: 'Home' } as const;
const refused = { status: 'token_refused', version: null, name: null } as const;

describe('testKey', () => {
	it('is the address as the server reads it and the token without spaces', () => {
		expect(testKey(' HTTP://192.168.1.20:8123/api/ ', ' abc ')).toBe(
			testKey('http://192.168.1.20:8123', 'abc'),
		);
	});

	it('is null while the address or the token cannot be used', () => {
		expect(testKey('not an address', 'abc')).toBeNull();
		expect(testKey('http://192.168.1.20:8123', '  ')).toBeNull();
	});
});

describe('formStep', () => {
	const key = testKey('http://192.168.1.20:8123', 'abc') as string;

	it('asks for a test first', () => {
		expect(formStep(null, key)).toBe('test');
		expect(formStep(null, null)).toBe('test');
	});

	it('offers Save after a good test and Save anyway after a failed one', () => {
		expect(formStep({ key, result: ok }, key)).toBe('save');
		expect(formStep({ key, result: refused }, key)).toBe('failed');
	});

	it('forgets a result as soon as the address or the token changes', () => {
		const tested = { key, result: ok };
		expect(formStep(tested, testKey('http://192.168.1.21:8123', 'abc'))).toBe('test');
		expect(formStep(tested, testKey('http://192.168.1.20:8123', 'abd'))).toBe('test');
		expect(formStep(tested, null)).toBe('test');
	});
});
