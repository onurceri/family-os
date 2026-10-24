import { describe, expect, it } from 'vitest';
import { offlinePatternsOf, offlineReadMatcher } from './offline-reads.js';

describe('offline reads', () => {
	const match = offlineReadMatcher([
		'/api/v1/lists/tasks',
		'/api/v1/lists/shopping/lists/:listId/items',
	]);

	it('matches a declared path whole, a :name segment standing for one segment', () => {
		expect(match('/api/v1/lists/tasks')).toBe(true);
		expect(match('/api/v1/lists/shopping/lists/shop_list_1/items')).toBe(true);
		expect(match('/api/v1/lists/tasks/extra')).toBe(false);
		expect(match('/api/v1/lists/shopping/lists//items')).toBe(false);
		expect(match('/api/v1/lists/shopping/lists/a/b/items')).toBe(false);
		expect(match('/api/v1/chores/chores')).toBe(false);
	});

	it('keeps nothing without a declaration', () => {
		expect(offlineReadMatcher([])('/api/v1/lists/tasks')).toBe(false);
	});

	it('takes only API paths from a message', () => {
		expect(offlinePatternsOf(['/api/v1/a/b', '/other', 3, '/api/v1/a/:id'])).toEqual([
			'/api/v1/a/b',
			'/api/v1/a/:id',
		]);
		expect(offlinePatternsOf('nope')).toEqual([]);
	});
});
