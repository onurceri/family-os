import { Temporal } from '@famos/time';
import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import { describe, expect, it } from 'vitest';
import catalog from '../src/messages/en.json';
import { emptyForm, inputFrom, validate, weekdaysAfterDateChange } from '../src/web/form.ts';

// Every reason a form gives is a shared one or a key of this extension's catalog.
const shared = new Set<string>(Object.values(FIELD_REASON));
const known = (errors: FieldErrors) => {
	for (const [field, key] of Object.entries(errors)) {
		const own = key.startsWith('calendar:') && key.slice(9) in catalog;
		expect(shared.has(key) || own, `${field}: ${key}`).toBe(true);
	}
	return errors;
};

describe('event form reasons', () => {
	const now = Temporal.ZonedDateTime.from('2026-10-15T10:00[Europe/Berlin]');
	const base = () => ({ ...emptyForm('2026-10-20', now), title: 'Zoo trip' });

	it('says why Save is refused, field by field', () => {
		expect(validate(base())).toEqual({});
		expect(known(validate({ ...base(), title: '  ' }))).toEqual({ title: FIELD_REASON.title });
		expect(known(validate({ ...base(), startTime: '' })).startTime).toBe(FIELD_REASON.time);
		expect(known(validate({ ...base(), repeat: 'weekly', byDay: [] })).recurrence).toBe(
			FIELD_REASON.repeatDays,
		);
		expect(known(validate({ ...base(), repeat: 'custom' })).recurrence).toBe(FIELD_REASON.repeat);
		expect(known(validate({ ...base(), repeat: 'daily', until: '2026-10-01' })).until).toBe(
			FIELD_REASON.beforeStart,
		);
		expect(known(validate({ ...base(), allDay: true, endDate: '2026-10-19' })).endDate).toBe(
			FIELD_REASON.beforeStart,
		);
		expect(known(validate({ ...base(), startTime: '10:00', endTime: '10:00' })).endTime).toBe(
			'calendar:error_end_same',
		);
	});
});

describe('weekly repeat days follow the date', () => {
	const now = Temporal.ZonedDateTime.from('2026-10-17T10:00[Europe/Berlin]');

	// 2026-10-17 is a Saturday, 2026-10-22 a Thursday.
	it('starts on the weekday of the first date and moves with the date', () => {
		const form = { ...emptyForm('2026-10-17', now), title: 'Call', repeat: 'weekly' as const };
		expect(form.byDay).toEqual(['SA']);
		form.date = '2026-10-22';
		form.byDay = weekdaysAfterDateChange(form.byDay, form.date);
		expect(form.byDay).toEqual(['TH']);
		const input = inputFrom(form);
		expect(input.recurrence).toMatchObject({ freq: 'weekly', byDay: ['TH'] });
	});

	it('follows a date changed twice', () => {
		let byDay = ['SA'];
		byDay = weekdaysAfterDateChange(byDay, '2026-10-22');
		byDay = weekdaysAfterDateChange(byDay, '2026-10-26');
		expect(byDay).toEqual(['MO']);
	});

	it('keeps chosen days that still include the new date, else follows the date', () => {
		expect(weekdaysAfterDateChange(['TU', 'TH'], '2026-10-22')).toEqual(['TU', 'TH']);
		expect(weekdaysAfterDateChange(['TU', 'TH'], '2026-10-23')).toEqual(['FR']);
	});

	it('leaves the days alone while the date is not complete', () => {
		expect(weekdaysAfterDateChange(['SA'], '')).toEqual(['SA']);
		expect(weekdaysAfterDateChange(['SA'], '2026-10-2')).toEqual(['SA']);
	});
});
