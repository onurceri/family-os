import { describe, expect, it } from 'vitest';
import { addressDiffers, closedFor, firstScope, scopeChoices } from './outcome.js';

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

	it('warns when an app named by its address sends the sign-in somewhere else', () => {
		const named = (clientHost: string | null) => ({ kind: 'metadata' as const, clientHost });
		expect(addressDiffers(named('claude.ai'), 'claude.ai')).toBe(false);
		expect(addressDiffers(named('app.example'), 'evil.example')).toBe(true);
		expect(addressDiffers(named('claude.ai'), 'localhost:53412')).toBe(true);
		expect(addressDiffers({ kind: 'dynamic', clientHost: null }, 'app.example')).toBe(false);
		expect(addressDiffers({ kind: 'registered', clientHost: null }, 'app.example')).toBe(false);
	});
});
