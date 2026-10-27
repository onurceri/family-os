import { describe, expect, it } from 'vitest';
import { BootGuard, isBrowserFailure } from './boot-failure.js';

describe('boot failure', () => {
	it('counts a missing feature, not a failed request', () => {
		expect(isBrowserFailure(new TypeError('e.toSorted is not a function'))).toBe(true);
		expect(isBrowserFailure(new ReferenceError('x is not defined'))).toBe(true);
		expect(isBrowserFailure(new TypeError('Failed to fetch'))).toBe(false);
		expect(isBrowserFailure(new Error('boom'))).toBe(false);
		expect(isBrowserFailure('text')).toBe(false);
	});

	it('flags a failed start only until the app is up', () => {
		const seen: boolean[] = [];
		const guard = new BootGuard((failed) => seen.push(failed));
		expect(guard.report(new Error('other'))).toBe(false);
		expect(guard.report(new TypeError('a.with is not a function'))).toBe(true);
		expect(guard.failed).toBe(true);
		guard.up();
		expect(guard.failed).toBe(false);
		expect(guard.report(new TypeError('later'))).toBe(false);
		expect(seen).toEqual([true, false]);
	});

	it('hears thrown errors and rejected promises', () => {
		const handlers = new Map<string, (event: unknown) => void>();
		const guard = new BootGuard(() => {});
		guard.listen({
			addEventListener: ((type: string, handler: (event: unknown) => void) =>
				handlers.set(type, handler)) as Window['addEventListener'],
		});
		handlers.get('unhandledrejection')?.({ reason: new TypeError('a.toSorted is not a function') });
		expect(guard.failed).toBe(true);
	});
});
