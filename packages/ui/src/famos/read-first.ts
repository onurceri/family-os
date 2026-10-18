import type { Snippet } from 'svelte';
import type { AppContext } from '../app-context.js';

/**
 * What a row's panel opens on for this viewer (`SidePanel`'s `readFirst`): when their change to
 * the thing would wait for approval, its details with "Suggest a change", which opens the form;
 * for someone who changes it directly (or may not change it at all) nothing, and the panel is
 * as it was. With an input, the exact answer for it (whose thing it is can decide).
 */
export function readFirst(
	app: Pick<AppContext, 'access' | 'accessFor' | 't'>,
	actionId: string,
	details: Snippet,
	options: { input?: unknown; key?: string } = {},
): { details: Snippet; label: string; key?: string } | undefined {
	const answer =
		options.input === undefined ? app.access(actionId) : app.accessFor(actionId, options.input);
	if (answer !== 'suggest') return undefined;
	return {
		details,
		label: app.t('app:suggest_change'),
		...(options.key === undefined ? {} : { key: options.key }),
	};
}

/** The words of a record page's edit button: "Suggest a change" when the change would wait. */
export function editLabel(
	app: Pick<AppContext, 'access' | 'accessFor' | 't'>,
	actionId: string,
	label: string,
	input?: unknown,
): string {
	const answer = input === undefined ? app.access(actionId) : app.accessFor(actionId, input);
	return answer === 'suggest' ? app.t('app:suggest_change') : label;
}
