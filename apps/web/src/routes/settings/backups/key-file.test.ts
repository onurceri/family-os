import { describe, expect, it } from 'vitest';
import { keyFileFailure } from './key-file.js';

const error = (status: number, code: string, details?: unknown) => ({
	status,
	code,
	message: '',
	details,
});

describe('keyFileFailure', () => {
	it('tells a wrong password from a PIN sign-in and from a lock', () => {
		expect(keyFileFailure(error(403, 'forbidden', { reason: 'wrong_password' }))).toBe(
			'wrong_password',
		);
		expect(keyFileFailure(error(403, 'forbidden', { reason: 'full_sign_in' }))).toBe(
			'password_sign_in',
		);
		expect(keyFileFailure(error(429, 'limit_reached', { retryAfter: 60 }))).toBe('locked');
	});

	it('leaves anything else to the generic message', () => {
		expect(keyFileFailure(error(403, 'forbidden'))).toBe('other');
		expect(keyFileFailure(error(500, 'internal'))).toBe('other');
	});
});
