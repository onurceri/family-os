import { tick } from 'svelte';
import { focusables } from './focus.js';

/**
 * A form's errors: field path → the translation key of the reason (`app:field_name_required`,
 * `calendar:error_until`). A field without an entry is fine. The form shows the reason under the
 * field with `FieldError`, so a red border never stands alone and a screen reader hears why.
 */
export type FieldErrors = Record<string, string>;

/** Reasons every form shares (the app's catalog); an extension adds its own for the rest. */
export const FIELD_REASON = {
	required: 'app:field_required',
	name: 'app:field_name_required',
	title: 'app:field_title_required',
	date: 'app:field_date_required',
	time: 'app:field_time_required',
	tooLong: 'app:field_too_long',
	repeat: 'app:field_repeat_choose',
	repeatDays: 'app:field_repeat_days',
	beforeStart: 'app:field_before_start',
	check: 'app:field_check',
} as const;

/** The parts of a validation issue (a Zod issue) that say which field failed and how. */
export interface FieldIssue {
	readonly path: readonly PropertyKey[];
	readonly code: string;
}

/**
 * Adds a reason for each schema issue whose field has none yet: the reason given for that field
 * in `reasons`, else one from the kind of issue. The first reason per field wins, so checks a
 * form makes before the schema keep their own words.
 */
export function issueErrors(
	errors: FieldErrors,
	issues: readonly FieldIssue[],
	reasons: Readonly<Record<string, string>> = {},
): FieldErrors {
	for (const issue of issues) {
		const field = String(issue.path[0] ?? 'form');
		if (errors[field]) continue;
		errors[field] =
			reasons[field] ??
			(issue.code === 'too_big'
				? FIELD_REASON.tooLong
				: issue.code === 'too_small'
					? FIELD_REASON.required
					: FIELD_REASON.check);
	}
	return errors;
}

/** The id of the reason shown under the field with this input id. */
export const fieldErrorId = (inputId: string) => `${inputId}-error`;

/** `aria-invalid` and `aria-describedby` for a field: spread them on the input. */
export function fieldAria(
	error: string | undefined,
	inputId: string,
): { 'aria-invalid': 'true' | undefined; 'aria-describedby': string | undefined } {
	return {
		'aria-invalid': error ? 'true' : undefined,
		'aria-describedby': error ? fieldErrorId(inputId) : undefined,
	};
}

/**
 * After a refused Save, moves focus to the first field marked invalid in `root` (the form), so
 * the person and a screen reader land on what to fix. A marked group (the weekday chips) gets its
 * first control.
 */
export async function focusFirstInvalid(root: EventTarget | null | undefined): Promise<void> {
	if (!(root instanceof HTMLElement)) return;
	await tick();
	const marked = root.querySelector<HTMLElement>('[aria-invalid="true"]');
	if (!marked) return;
	const target = marked.matches('input, select, textarea, button, [tabindex]')
		? marked
		: focusables(marked)[0];
	target?.focus();
}
