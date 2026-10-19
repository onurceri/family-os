import { firstRepeatDate, Temporal, weekdaysAfterDateChange } from '@famos/time';
import { FIELD_REASON, type FieldErrors } from '@famos/ui/forms';
import { describe, expect, it } from 'vitest';
import catalog from '../src/messages/en.json';
import {
	asksWhichDates,
	atOccurrence,
	emptyForm,
	fromThisDateForm,
	inputFrom,
	onlyThisDateForm,
	validate,
} from '../src/web/form.ts';

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
		expect(validate({ ...base(), repeat: 'custom' }).recurrence).toBeUndefined();
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
		form.byDay = weekdaysAfterDateChange(form.byDay, form.date, '2026-10-22');
		form.date = '2026-10-22';
		expect(form.byDay).toEqual(['TH']);
		const input = inputFrom(form);
		expect(input.recurrence).toMatchObject({ freq: 'weekly', byDay: ['TH'] });
	});

	it('keeps days the person chose when the date changes', () => {
		const form = {
			...emptyForm('2026-10-17', now),
			repeat: 'weekly' as const,
			byDay: ['MO', 'WE'],
		};
		form.byDay = weekdaysAfterDateChange(form.byDay, form.date, '2026-10-22');
		expect(inputFrom({ ...form, title: 'Call' }).recurrence).toMatchObject({
			byDay: ['MO', 'WE', 'TH'],
		});
	});
});

describe('a saved weekly event keeps its days when its date moves', () => {
	it('stays every Tuesday', () => {
		const now = Temporal.ZonedDateTime.from('2026-10-17T10:00[Europe/Berlin]');
		const form = {
			...emptyForm('2026-10-18', now),
			title: 'Bins',
			repeat: 'weekly' as const,
			byDay: ['TU'],
		};
		form.byDay = weekdaysAfterDateChange(form.byDay, form.date, '2026-10-21', true);
		form.date = '2026-10-21';
		expect(inputFrom(form).recurrence).toMatchObject({ freq: 'weekly', byDay: ['TU'] });
		expect(firstRepeatDate(form.date, form.byDay)).toBe('2026-10-27');
	});
});

describe('saving a change to a saved weekly event', () => {
	const now = Temporal.ZonedDateTime.from('2026-10-17T10:00[Europe/Berlin]');
	// Opened from its date on Sunday 18 October.
	const saved = () =>
		atOccurrence(
			{ ...emptyForm('2026-10-11', now), title: 'Bins', repeat: 'weekly' as const, byDay: ['TU'] },
			'2026-10-18',
		);

	it('opens on the date it was opened from', () => {
		expect(saved().date).toBe('2026-10-18');
		expect(atOccurrence({ ...saved(), repeat: 'none' }, '2026-10-25').date).toBe('2026-10-18');
	});

	it('asks only when the date or the days moved', () => {
		expect(asksWhichDates(saved(), saved())).toBe(false);
		expect(asksWhichDates(saved(), { ...saved(), date: '2026-10-21' })).toBe(true);
		expect(asksWhichDates(saved(), { ...saved(), byDay: ['TU', 'WE'] })).toBe(true);
	});

	it('only this one is a single event on the new day', () => {
		const sent = onlyThisDateForm(saved(), { ...saved(), date: '2026-10-21' }, '2026-10-19');
		expect(sent).toMatchObject({ date: '2026-10-21', repeat: 'none' });
		expect(inputFrom(sent).recurrence).toBeUndefined();
	});

	it('this one and the ones after starts its first matching day', () => {
		const sent = fromThisDateForm(saved(), { ...saved(), date: '2026-10-21' }, '2026-10-19');
		expect(sent).toMatchObject({ date: '2026-10-27', byDay: ['TU'] });
		expect(inputFrom(sent).recurrence).toMatchObject({ freq: 'weekly', byDay: ['TU'] });
	});
});
