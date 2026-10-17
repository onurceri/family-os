import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import { describe, expect, it } from 'vitest';
import catalog from '../src/messages/en.json';
import { emptyTask, validateTask } from '../src/web/task-form.ts';

// Every reason a form gives is a shared one or a key of this extension's catalog.
const shared = new Set<string>(Object.values(FIELD_REASON));
const known = (errors: FieldErrors) => {
	for (const [field, key] of Object.entries(errors)) {
		const own = key.startsWith('lists:') && key.slice(6) in catalog;
		expect(shared.has(key) || own, `${field}: ${key}`).toBe(true);
	}
	return errors;
};

describe('task form reasons', () => {
	const base = () => ({ ...emptyTask(null, '2026-10-15'), title: 'Sign the form' });

	it('says why Save is refused, field by field', () => {
		expect(validateTask(base())).toEqual({});
		expect(known(validateTask({ ...base(), title: '' }))).toEqual({ title: FIELD_REASON.title });
		expect(known(validateTask({ ...base(), repeat: 'daily' })).dueDate).toBe(
			'lists:error_repeat_date',
		);
		expect(
			known(validateTask({ ...base(), dueDate: '2026-10-15', repeat: 'weekly', byDay: [] }))
				.recurrence,
		).toBe(FIELD_REASON.repeatDays);
		expect(
			known(
				validateTask({ ...base(), dueDate: '2026-10-15', repeat: 'daily', until: '2026-10-01' }),
			).until,
		).toBe(FIELD_REASON.beforeStart);
	});
});
