import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import { describe, expect, it } from 'vitest';
import catalog from '../src/messages/en.json';
import { doneToast, emptyChore, validate } from '../src/web/form.ts';

// Every reason a form gives is a shared one or a key of this extension's catalog.
const shared = new Set<string>(Object.values(FIELD_REASON));
const known = (errors: FieldErrors) => {
	for (const [field, key] of Object.entries(errors)) {
		const own = key.startsWith('chores:') && key.slice(7) in catalog;
		expect(shared.has(key) || own, `${field}: ${key}`).toBe(true);
	}
	return errors;
};

describe('chore form reasons', () => {
	const base = () => ({ ...emptyChore('2026-10-15'), title: 'Empty the dishwasher' });

	it('says why Save is refused, field by field', () => {
		expect(validate(base())).toEqual({});
		expect(known(validate({ ...base(), title: '' }))).toEqual({ title: FIELD_REASON.title });
		expect(known(validate({ ...base(), startDate: '' })).startDate).toBe(FIELD_REASON.date);
		expect(known(validate({ ...base(), byDay: [] })).recurrence).toBe(FIELD_REASON.repeatDays);
		expect(known(validate({ ...base(), until: '2026-10-01' })).until).toBe(
			FIELD_REASON.beforeStart,
		);
	});
});

describe('the toast after a tick', () => {
	const t = ((key: string, options: Record<string, string> = {}) =>
		(catalog as Record<string, string>)[key]?.replace(
			/\{\{(\w+)\}\}/g,
			(_, name: string) => options[name] ?? '',
		) ?? key) as unknown as Parameters<typeof doneToast>[3];
	const today = '2026-10-15';

	it('just says done for a chore due today or before', () => {
		expect(doneToast('Walk Biscuit', today, today, t, 'en-GB')).toBe('Walk Biscuit done');
		expect(doneToast('Walk Biscuit', '2026-10-13', today, t, 'en-GB')).toBe('Walk Biscuit done');
	});

	it('names the day an early tick counted for', () => {
		expect(doneToast('Walk Biscuit', '2026-10-16', today, t, 'en-GB')).toBe(
			'Walk Biscuit done for tomorrow',
		);
		expect(doneToast('Water the plants', '2026-10-18', today, t, 'en-GB')).toBe(
			'Water the plants done for Sunday',
		);
	});
});
