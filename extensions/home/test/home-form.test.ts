import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import { describe, expect, it } from 'vitest';
import catalog from '../src/messages/en.json';
import {
	emptyHome,
	emptyItem,
	emptyService,
	validateHome,
	validateItem,
	validateService,
} from '../src/web/form.ts';

// Every reason a form gives is a shared one or a key of this extension's catalog.
const shared = new Set<string>(Object.values(FIELD_REASON));
const known = (errors: FieldErrors) => {
	for (const [field, key] of Object.entries(errors)) {
		const own = key.startsWith('home:') && key.slice(5) in catalog;
		expect(shared.has(key) || own, `${field}: ${key}`).toBe(true);
	}
	return errors;
};

describe('home form reasons', () => {
	it('says why Save is refused, field by field', () => {
		expect(known(validateHome(emptyHome()))).toEqual({ name: FIELD_REASON.name });
		expect(validateHome({ ...emptyHome(), name: 'Flat' })).toEqual({});
		expect(
			known(
				validateItem({
					...emptyItem(),
					name: 'Washer',
					purchasedOn: '2026-01-10',
					warrantyUntil: '2025-01-10',
				}),
			),
		).toEqual({ warrantyUntil: 'home:error_warranty_before_purchase' });
		expect(known(validateItem(emptyItem())).name).toBe(FIELD_REASON.name);
		expect(known(validateService({ ...emptyService(), dueDay: '40' }))).toEqual({
			provider: 'home:error_provider',
			dueDay: 'home:error_due_day',
		});
	});
});
