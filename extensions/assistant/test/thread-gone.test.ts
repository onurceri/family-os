import { describe, expect, it } from 'vitest';
import { threadIsGone } from '../src/web/thread-gone.ts';

describe('threadIsGone', () => {
	it('is true when the server says the thread is not found', () => {
		expect(threadIsGone({ status: 404, code: 'not_found', message: 'Thread not found' })).toBe(
			true,
		);
	});

	it('is false for a gateway error during a restart', () => {
		expect(threadIsGone({ status: 502, code: 'unknown', message: 'Bad Gateway' })).toBe(false);
	});

	it('is false for other refusals and for a dropped request', () => {
		expect(threadIsGone({ status: 403, code: 'forbidden', message: 'No' })).toBe(false);
		expect(threadIsGone(new TypeError('Failed to fetch'))).toBe(false);
		expect(threadIsGone(undefined)).toBe(false);
	});
});
