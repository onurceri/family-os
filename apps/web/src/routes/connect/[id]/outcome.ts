/** Why a sign-in request cannot be decided here, from how the server answered. */
export type Closed = 'gone' | 'other' | 'off' | 'failed';

/**
 * 410: the request ended or was answered; 403: the app belongs to someone else (the role and the
 * sign-in were checked before asking); 404: signing in AI apps is off.
 */
export function closedFor(status: number | undefined): Closed {
	if (status === 410) return 'gone';
	if (status === 403) return 'other';
	if (status === 404) return 'off';
	return 'failed';
}

/** What the person may choose: never more than the app asked for. */
export const scopeChoices = (asked: 'read' | 'read_write'): ('read' | 'read_write')[] =>
	asked === 'read' ? ['read'] : ['read_write', 'read'];

/** The choice the page starts on: everything the app asked for, as far as the person may give it. */
export const firstScope = (asked: 'read' | 'read_write'): 'read' | 'read_write' =>
	scopeChoices(asked)[0] ?? 'read';
