import { normalizeBaseUrl, type TestResult } from '../contract/index.js';

/**
 * The form's way from typing to saving: the address and token are tried first, and what was
 * found belongs only to the exact details that were tried. Pure, so a test needs no browser.
 */

export interface Tested {
	key: string;
	result: TestResult;
}

/** The details as the server reads them; null while the address cannot be one. */
export function testKey(address: string, token: string): string | null {
	const base = normalizeBaseUrl(address);
	const word = token.trim();
	return base && word ? `${base.url}\n${word}` : null;
}

/**
 * What the form offers next: `test` before anything was tried (and after any edit), `save` after
 * a good test, `failed` after a bad one, where saving anyway is still possible.
 */
export function formStep(tested: Tested | null, key: string | null): 'test' | 'save' | 'failed' {
	if (!tested || key === null || tested.key !== key) return 'test';
	return tested.result.status === 'ok' ? 'save' : 'failed';
}
