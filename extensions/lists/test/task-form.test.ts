import { weekdaysAfterDateChange } from '@famos/time';
import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import { describe, expect, it } from 'vitest';
import catalog from '../src/messages/en.json';
import { emptyTask, taskFormFrom, taskInputFrom, validateTask } from '../src/web/task-form.ts';

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
	const base = () => ({ ...emptyTask(null), title: 'Sign the form' });

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

describe('the weekly days follow the due date', () => {
	// 2026-10-20 is a Tuesday, 2026-10-22 a Thursday.
	const moveTo = (form: ReturnType<typeof emptyTask>, date: string) => ({
		...form,
		byDay: weekdaysAfterDateChange(form.byDay, form.dueDate, date),
		dueDate: date,
	});

	it('gives a new task the weekday of the date set after choosing weekly', () => {
		const form = { ...emptyTask(null), title: 'Water plants', repeat: 'weekly' as const };
		expect(form.byDay).toEqual([]);
		const moved = moveTo(form, '2026-10-20');
		expect(taskInputFrom(moved).recurrence).toMatchObject({ freq: 'weekly', byDay: ['TU'] });
		expect(taskInputFrom(moveTo(moved, '2026-10-22')).recurrence).toMatchObject({ byDay: ['TH'] });
	});

	it('keeps the days that were chosen and adds the new date', () => {
		const form = { ...emptyTask(null), title: 'Water plants', repeat: 'weekly' as const };
		const chosen = { ...form, byDay: ['TU', 'TH'] };
		expect(moveTo(chosen, '2026-10-23').byDay).toEqual(['TU', 'TH', 'FR']);
	});

	it('starts an edited task without a repeat on the weekday of its date', () => {
		const form = taskFormFrom({ title: 'Call', dueDate: '2026-10-20', recurrence: null } as never);
		expect(form.byDay).toEqual(['TU']);
	});
});
