import type { ApiTokenScope } from '../api-tokens.ts';
import { OAUTH_SCOPES } from './constants.ts';

export const SCOPE_OF: Record<ApiTokenScope, string> = {
	read: 'familyos.read',
	read_write: 'familyos.read familyos.suggest',
};

/** The most an app asked for. Words it does not know are ignored and never widen the grant. */
export function ceilingOf(scope: string | undefined): ApiTokenScope {
	const words = new Set((scope ?? '').split(/\s+/).filter(Boolean));
	const known = OAUTH_SCOPES.filter((s) => words.has(s));
	if (known.length === 0) return 'read_write';
	return words.has('familyos.suggest') ? 'read_write' : 'read';
}

export function fromScopeText(text: string): ApiTokenScope | null {
	const words = new Set(text.split(/\s+/).filter(Boolean));
	if (words.size === 0) return null;
	for (const w of words) if (!(OAUTH_SCOPES as readonly string[]).includes(w)) return null;
	return words.has('familyos.suggest') ? 'read_write' : 'read';
}
