import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	REFUSAL_KEYS,
	REFUSAL_QUIET_MS,
	RefusalWindow,
	reasonOfBody,
	refusalKey,
	refusalOfError,
} from './refusal.js';

const read = (file: string) =>
	JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')) as Record<string, string>;
const en = read('../messages/en.json');
const tr = read('../../../../languages/tr/app.json');

// The reasons the server names in a 403 (`ACCESS_REFUSALS` in packages/core/src/decide.ts).
const SERVER_REASONS = ['capability', 'approval', 'display', 'sign_in', 'ai', 'critical', 'area'];

describe('refusal words', () => {
	it('has words for every reason the server gives, in English and Turkish', () => {
		for (const reason of SERVER_REASONS) {
			const key = refusalKey(reason);
			expect(en[key], reason).toBeTruthy();
			expect(tr[key], reason).toBeTruthy();
		}
		expect(Object.keys(REFUSAL_KEYS).sort()).toEqual([...SERVER_REASONS].sort());
	});

	it('says each reason differently', () => {
		const words = SERVER_REASONS.map((reason) => en[refusalKey(reason)]);
		expect(new Set(words).size).toBe(SERVER_REASONS.length);
	});

	it('names the role for a refusal without a reason or with one it does not know', () => {
		expect(refusalKey(undefined)).toBe('refused_capability');
		expect(refusalKey('something_new')).toBe('refused_capability');
		expect(refusalKey(42)).toBe('refused_capability');
	});

	it('says what to do about approval, displays and sign-in in plain words', () => {
		expect(en[refusalKey('approval')]).toContain('approval');
		expect(en[refusalKey('display')]).toContain('display');
		expect(en[refusalKey('sign_in')]).toMatch(/sign in/i);
	});

	it('never shows an action or capability id or a placeholder', () => {
		for (const key of Object.values(REFUSAL_KEYS)) {
			expect(en[key]).not.toMatch(/\b[a-z]+\.[a-zA-Z]+\b/);
			expect(en[key]).not.toContain('{{');
		}
	});
});

describe('reading a refusal', () => {
	it('takes the reason out of an API error body', () => {
		const body = {
			error: { code: 'forbidden', reason: 'approval', capability: 'x.edit' },
		};
		expect(reasonOfBody(body)).toBe('approval');
	});

	it('copes with bodies that have none', () => {
		expect(reasonOfBody(null)).toBeUndefined();
		expect(reasonOfBody({ error: { code: 'forbidden' } })).toBeUndefined();
		expect(reasonOfBody({ error: { reason: 3 } })).toBeUndefined();
	});

	it('knows a refused call from other failures', () => {
		expect(refusalOfError({ status: 403, reason: 'display' })).toEqual({
			reason: 'display',
		});
		expect(refusalOfError({ status: 403 })).toEqual({});
		expect(refusalOfError({ status: 500 })).toBeNull();
		expect(refusalOfError(new Error('x'))).toBeNull();
		expect(refusalOfError(null)).toBeNull();
	});
});

describe('RefusalWindow', () => {
	it('keeps a page’s generic failure notice from covering the words, for a moment', () => {
		const window = new RefusalWindow();
		expect(window.quiet(0)).toBe(false);
		window.said('Your role does not allow this.', 1000);
		expect(window.quiet(1000 + REFUSAL_QUIET_MS - 1)).toBe(true);
		expect(window.recent(1500)).toBe('Your role does not allow this.');
		expect(window.quiet(1000 + REFUSAL_QUIET_MS)).toBe(false);
		expect(window.recent(1000 + REFUSAL_QUIET_MS)).toBeUndefined();
	});
});
