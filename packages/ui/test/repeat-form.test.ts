import { describe, expect, it } from 'vitest';
import { recurrenceFromFields, repeatFieldsFrom } from '../src/famos/repeat-form.js';

describe('repeatFieldsFrom', () => {
	it('reads every frequency', () => {
		expect(repeatFieldsFrom(null, '2026-10-21')).toEqual({
			repeat: 'none',
			byDay: ['WE'],
			interval: 1,
			until: '',
		});
		expect(
			repeatFieldsFrom({ freq: 'daily', interval: 2, until: '2026-12-01' }, '2026-10-21'),
		).toEqual({
			repeat: 'daily',
			byDay: ['WE'],
			interval: 2,
			until: '2026-12-01',
		});
		expect(repeatFieldsFrom({ freq: 'monthly', interval: 3 }, '2026-10-21').repeat).toBe('monthly');
		expect(
			repeatFieldsFrom({ freq: 'weekly', interval: 1, byDay: ['MO', 'FR'] }, '2026-10-21'),
		).toMatchObject({ repeat: 'weekly', byDay: ['MO', 'FR'] });
	});

	it('leaves the days empty without an anchor and marks a custom rule', () => {
		expect(repeatFieldsFrom(undefined, null).byDay).toEqual([]);
		expect(repeatFieldsFrom(null, '2026-10-21', true).repeat).toBe('custom');
	});
});

describe('recurrenceFromFields', () => {
	const base = { byDay: ['MO'], interval: 2, until: '' };
	it('builds each frequency', () => {
		expect(recurrenceFromFields({ ...base, repeat: 'daily' })).toEqual({
			freq: 'daily',
			interval: 2,
		});
		expect(recurrenceFromFields({ ...base, repeat: 'monthly', until: ' 2027-01-01 ' })).toEqual({
			freq: 'monthly',
			interval: 2,
			until: '2027-01-01',
		});
		expect(recurrenceFromFields({ ...base, repeat: 'weekly' })).toEqual({
			freq: 'weekly',
			interval: 2,
			byDay: ['MO'],
		});
	});
	it('is null for none and custom', () => {
		expect(recurrenceFromFields({ ...base, repeat: 'none' })).toBeNull();
		expect(recurrenceFromFields({ ...base, repeat: 'custom' })).toBeNull();
	});
	it('round-trips what it reads', () => {
		const rec = { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'], until: '2027-02-02' } as const;
		expect(recurrenceFromFields(repeatFieldsFrom(rec, '2026-10-21'))).toEqual(rec);
	});
});
