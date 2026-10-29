import { SetupAccountSchema } from '@famos/sdk/setup';
import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';

/** What the person typed into the setup form. */
export interface SetupFields {
	familyName: string;
	displayName: string;
	email: string;
	password: string;
	setupCode: string;
}

/** The setup form's field → the id of its input, where its reason shows. */
export const SETUP_INPUTS = {
	setupCode: 'setup-code',
	familyName: 'family-name',
	displayName: 'name',
	email: 'email',
	password: 'password',
} as const satisfies Record<keyof SetupFields, string>;

type Field = keyof SetupFields;
const isField = (name: string): name is Field => Object.hasOwn(SETUP_INPUTS, name);

/** Why a field was refused, in words for that field. `tooBig` only when the value is too long. */
function reasonFor(field: Field, tooBig: boolean): string {
	if (tooBig) return FIELD_REASON.tooLong;
	switch (field) {
		case 'setupCode':
			return 'app:setup_code_missing';
		case 'displayName':
			return 'app:setup_name_required';
		case 'email':
			return 'app:setup_email_invalid';
		case 'password':
			return 'app:setup_password_short';
		case 'familyName':
			return FIELD_REASON.check;
	}
}

/**
 * Checks the setup form with the server's own schema before anything is sent. Names are trimmed
 * (a name of spaces is no name); an empty family name is left out. The code is required when the
 * server asks for one.
 */
export function checkSetup(
	fields: SetupFields,
	needsCode: boolean,
): {
	errors: FieldErrors;
	body: {
		displayName: string;
		email: string;
		password: string;
		familyName?: string;
		setupCode?: string;
	};
} {
	const familyName = fields.familyName.trim();
	const setupCode = fields.setupCode.trim();
	const body = {
		displayName: fields.displayName.trim(),
		email: fields.email.trim(),
		password: fields.password,
		...(familyName && { familyName }),
		...(needsCode && { setupCode }),
	};
	const errors: FieldErrors = {};
	if (needsCode && !setupCode) errors.setupCode = reasonFor('setupCode', false);
	const result = SetupAccountSchema.safeParse(body);
	if (!result.success) {
		for (const issue of result.error.issues) {
			const field = String(issue.path[0] ?? '');
			if (isField(field) && !errors[field])
				errors[field] = reasonFor(field, issue.code === 'too_big');
		}
	}
	return { errors, body };
}

/**
 * The fields a refused setup request names (the server's 400 lists them as `properties`), each
 * with its reason. Nothing when the answer names no field the form has.
 */
export function serverSetupErrors(details: unknown): FieldErrors {
	const properties =
		typeof details === 'object' && details !== null && 'properties' in details
			? (details as { properties?: unknown }).properties
			: undefined;
	if (typeof properties !== 'object' || properties === null) return {};
	const errors: FieldErrors = {};
	for (const field of Object.keys(properties)) {
		if (isField(field)) errors[field] = reasonFor(field, false);
	}
	return errors;
}
