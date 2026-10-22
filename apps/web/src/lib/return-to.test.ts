import { describe, expect, it } from 'vitest';
import { isReturnable, rememberReturn, takeReturn } from './return-to.js';

const memory = (): Storage => {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (k) => map.get(k) ?? null,
		key: (i) => [...map.keys()][i] ?? null,
		removeItem: (k) => void map.delete(k),
		setItem: (k, v) => void map.set(k, v),
	};
};

describe('returning to an AI app’s sign-in after signing in', () => {
	it('remembers a sign-in page once', () => {
		const storage = memory();
		rememberReturn('/connect/oauth_req_abc-123', storage);
		expect(takeReturn(storage)).toBe('/connect/oauth_req_abc-123');
		expect(takeReturn(storage)).toBeNull();
	});

	it('remembers nothing else, so no stored value can send a person elsewhere', () => {
		const storage = memory();
		for (const path of [
			'/',
			'/settings',
			'//evil.example',
			'/connect/',
			'/connect/a/b',
			'https://x.example/connect/a',
		])
			expect(isReturnable(path)).toBe(false);
		rememberReturn('//evil.example', storage);
		expect(takeReturn(storage)).toBeNull();
		storage.setItem('famos.returnTo', 'https://evil.example');
		expect(takeReturn(storage)).toBeNull();
	});

	it('works without storage', () => {
		const broken = {
			setItem() {
				throw new Error('blocked');
			},
			getItem() {
				throw new Error('blocked');
			},
		} as unknown as Storage;
		expect(() => rememberReturn('/connect/abc', broken)).not.toThrow();
		expect(takeReturn(broken)).toBeNull();
	});
});
