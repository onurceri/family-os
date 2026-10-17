import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import { describe, expect, it } from 'vitest';
import catalog from '../src/messages/en.json';
import { emptyVehicle, validate } from '../src/web/form.ts';

// Every reason a form gives is a shared one or a key of this extension's catalog.
const shared = new Set<string>(Object.values(FIELD_REASON));
const known = (errors: FieldErrors) => {
	for (const [field, key] of Object.entries(errors)) {
		const own = key.startsWith('vehicles:') && key.slice(9) in catalog;
		expect(shared.has(key) || own, `${field}: ${key}`).toBe(true);
	}
	return errors;
};

describe('vehicle form reasons', () => {
	it('says why Save is refused, field by field', () => {
		expect(known(validate(emptyVehicle()))).toEqual({ name: FIELD_REASON.name });
		expect(known(validate({ ...emptyVehicle(), name: 'Van', year: '15' }))).toEqual({
			year: 'vehicles:error_year',
		});
	});
});
