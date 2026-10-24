import { describe, expect, it } from 'vitest';
import { randomSecret, sameText, sha256Hex, toBase64Url } from '../src/secret-text.ts';

describe('secret text', () => {
	it('hashes to the standard SHA-256 hex', async () => {
		expect(await sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
	});

	it('encodes URL-safe without padding', () => {
		expect(toBase64Url(new Uint8Array([251, 255, 254]))).toBe('-__-');
		expect(toBase64Url(new Uint8Array([1]))).toBe('AQ');
	});

	it('mints URL-safe secrets of the asked size that differ every time', () => {
		const a = randomSecret();
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(randomSecret()).not.toBe(a);
		expect(randomSecret(16)).toHaveLength(22);
	});

	it('compares texts by content', () => {
		expect(sameText('a', 'a')).toBe(true);
		expect(sameText('a', 'ab')).toBe(false);
	});
});
