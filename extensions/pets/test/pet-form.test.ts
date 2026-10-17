import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import { describe, expect, it } from 'vitest';
import catalog from '../src/messages/en.json';
import { emptyPet, validate } from '../src/web/form.ts';

// Every reason a form gives is a shared one or a key of this extension's catalog.
const shared = new Set<string>(Object.values(FIELD_REASON));
const known = (errors: FieldErrors) => {
	for (const [field, key] of Object.entries(errors)) {
		const own = key.startsWith('pets:') && key.slice(5) in catalog;
		expect(shared.has(key) || own, `${field}: ${key}`).toBe(true);
	}
	return errors;
};

describe('pet form reasons', () => {
	it('says why Save is refused', () => {
		expect(known(validate(emptyPet()))).toEqual({ name: FIELD_REASON.name });
		expect(validate({ ...emptyPet(), name: 'Biscuit' })).toEqual({});
	});
});
