import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import { describe, expect, it } from 'vitest';
import catalog from '../src/messages/en.json';
import { emptyRecipe, validate } from '../src/web/form.ts';

// Every reason a form gives is a shared one or a key of this extension's catalog.
const shared = new Set<string>(Object.values(FIELD_REASON));
const known = (errors: FieldErrors) => {
	for (const [field, key] of Object.entries(errors)) {
		const own = key.startsWith('kitchen:') && key.slice(8) in catalog;
		expect(shared.has(key) || own, `${field}: ${key}`).toBe(true);
	}
	return errors;
};

describe('recipe form reasons', () => {
	it('says why Save is refused, field by field', () => {
		expect(known(validate(emptyRecipe()))).toEqual({ title: FIELD_REASON.title });
		expect(known(validate({ ...emptyRecipe(), title: 'Soup', sourceUrl: 'soup.example' }))).toEqual(
			{ sourceUrl: 'kitchen:error_source_url' },
		);
		expect(
			validate({ ...emptyRecipe(), title: 'Soup', sourceUrl: 'https://soup.example' }),
		).toEqual({});
	});
});
