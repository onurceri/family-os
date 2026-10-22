import { describe, expect, it } from 'vitest';
import { closedFor, firstScope, scopeChoices } from './outcome.js';

describe('the consent page', () => {
	it('tells an ended request, someone else’s app, and a switched-off door apart', () => {
		expect(closedFor(410)).toBe('gone');
		expect(closedFor(403)).toBe('other');
		expect(closedFor(404)).toBe('off');
		expect(closedFor(500)).toBe('failed');
		expect(closedFor(undefined)).toBe('failed');
	});

	it('offers the person at most what the app asked for, and starts on that', () => {
		expect(scopeChoices('read')).toEqual(['read']);
		expect(scopeChoices('read_write')).toEqual(['read_write', 'read']);
		expect(firstScope('read')).toBe('read');
		expect(firstScope('read_write')).toBe('read_write');
	});
});
