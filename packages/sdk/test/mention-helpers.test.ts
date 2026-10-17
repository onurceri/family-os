import { describe, expect, it } from 'vitest';
import {
	asAppointment,
	type DayRef,
	endNamed,
	type MentionContext,
	peopleNamed,
	type ResolvedDay,
	resolvePeople,
	stillToCome,
	unsureFields,
} from '../src/index.ts';

const MEMBERS = [
	{ id: 'm1', displayName: 'Mara' },
	{ id: 'm2', displayName: 'Ivy' },
];

/** A reading whose day helper answers what a model's parts would give, here a fixed date. */
const dayOf =
	(date: string | null): MentionContext['day'] =>
	(ref) =>
		ref && date ? ({ date, certain: true } satisfies ResolvedDay) : null;

describe('endNamed', () => {
	const ctx = (date: string | null) => ({ day: dayOf(date), today: '2026-10-06' });

	it('reads an end named by its month alone as the last day of that month', () => {
		// "until the end of October" read as a month is its first day; the end is its last.
		const ref: DayRef = { text: 'until the end of October', month: 10 };
		expect(endNamed(ctx('2026-10-06'), ref)).toEqual({ date: '2026-10-31', certain: true });
		expect(endNamed(ctx('2026-11-01'), { text: 'until November', month: 11 })).toEqual({
			date: '2026-11-30',
			certain: true,
		});
	});

	it('marks a span without a month as a guess, in this month', () => {
		expect(endNamed(ctx(null), { text: 'by the end of the month', approximate: true })).toEqual({
			date: '2026-10-31',
			certain: false,
			why: 'approximate',
		});
		expect(
			endNamed(ctx('2026-10-06'), { text: 'end of the month', month: 10, approximate: true }),
		).toEqual({ date: '2026-10-31', certain: false, why: 'approximate' });
	});

	it('keeps a day the model gives, also one written in words', () => {
		expect(
			endNamed(ctx('2026-10-20'), { text: 'until the twentieth of October', day: 20, month: 10 }),
		).toEqual({ date: '2026-10-20', certain: true });
		expect(
			endNamed(ctx('2026-10-28'), { text: 'until the end of October', day: 28, month: 10 }),
		).toEqual({ date: '2026-10-28', certain: true });
	});

	it('keeps a day the words write, a weekday or a count', () => {
		expect(endNamed(ctx('2026-10-28'), { text: 'until 28 October', day: 28, month: 10 })).toEqual({
			date: '2026-10-28',
			certain: true,
		});
		expect(endNamed(ctx('2026-10-09'), { text: 'by Friday', weekday: 5 })).toEqual({
			date: '2026-10-09',
			certain: true,
		});
		expect(endNamed(ctx('2026-10-20'), { text: 'in two weeks', inDays: 14 })).toEqual({
			date: '2026-10-20',
			certain: true,
		});
		// Parts without the words are taken as they are.
		expect(endNamed(ctx('2026-10-28'), { text: '', day: 28, month: 10 })).toEqual({
			date: '2026-10-28',
			certain: true,
		});
		expect(endNamed(ctx(null), undefined)).toBeNull();
	});
});

describe('peopleNamed', () => {
	const ctx = (text: string | null, sharer: string | null = 'm1') => ({
		sharer,
		text,
		members: MEMBERS,
		locale: 'en',
		people: (mention: Parameters<MentionContext['people']>[0]) =>
			resolvePeople(mention, { members: MEMBERS, sharer, text, locale: 'en' }),
	});

	it('doubts an assignment to the sharer alone when the text names nobody', () => {
		const text = 'Swim club: the term fee is due by Friday.';
		expect(peopleNamed(ctx(text), { forMe: true })).toEqual({
			ids: ['m1'],
			certain: false,
			unmatched: [],
		});
		// Files were read: there is no text that could name anyone.
		expect(peopleNamed(ctx(null), { forMe: true }).certain).toBe(false);
	});

	it('trusts the sharer when the text names someone, and leaves other people alone', () => {
		expect(peopleNamed(ctx('Mara, my dentist is on Friday'), { forMe: true }).certain).toBe(true);
		expect(peopleNamed(ctx('Ivy and I go to the dentist'), { forMe: true }).certain).toBe(true);
		expect(peopleNamed(ctx('Ivy has the dentist'), { people: ['Ivy'] })).toEqual({
			ids: ['m2'],
			certain: true,
			unmatched: [],
		});
		expect(peopleNamed(ctx('The fee is due', null), {}).ids).toEqual([]);
	});
});

describe('unsureFields', () => {
	it('maps the slots a model was unsure of to the fields they fill', () => {
		const fields = { date: 'date', time: ['startTime', 'allDay'], people: 'memberIds' };
		expect(unsureFields({ unsure: ['timeText', 'forMe', 'place', 'kind'] }, fields)).toEqual([
			'startTime',
			'allDay',
			'memberIds',
		]);
		expect(unsureFields({}, fields)).toEqual([]);
	});
});

describe('stillToCome', () => {
	const ctx = (day: ResolvedDay | null) => ({
		day: () => day,
		time: (m: { time?: string }) => (m.time ? { time: m.time, certain: true } : null),
		today: '2026-10-17',
		clock: '09:00',
	});
	const tomorrow = { date: '2026-10-18', certain: true };

	it('is a day after today, or today at a time still ahead', () => {
		// Found in use: "yarın … aşı randevusu saat 10" became a vaccination given today.
		expect(stillToCome(ctx(tomorrow), { date: { text: 'yarın' }, time: '10:00' })).toBe(true);
		expect(stillToCome(ctx(tomorrow), { date: { text: 'yarın' } })).toBe(true);
		expect(stillToCome(ctx(null), { time: '10:00' })).toBe(true);
		expect(stillToCome(ctx({ date: '2026-10-17', certain: true }), { time: '10:00' })).toBe(true);
	});

	it('is not something done: a past day, an hour gone, no day and no time, or a weekday alone', () => {
		expect(stillToCome(ctx({ date: '2026-10-16', certain: true }), { time: '10:00' })).toBe(false);
		expect(stillToCome(ctx(null), { time: '08:00' })).toBe(false);
		expect(stillToCome(ctx(null), {})).toBe(false);
		const weekday = { date: '2026-10-19', certain: false, why: 'weekday_only' as const };
		expect(stillToCome(ctx(weekday), { date: { text: 'Monday', weekday: 1 } })).toBe(false);
	});
});

describe('asAppointment', () => {
	it('keeps when and where, and names what it is for in front of the title', () => {
		const mention = {
			kind: 'pets.treatment',
			quote: 'biscuit aşı randevusu saat 10',
			title: 'Aşı randevusu',
			about: 'biscuit',
			variant: 'vaccination',
			date: { text: 'yarın', inDays: 1 },
			time: '10:00',
			timeText: 'saat 10',
			place: 'Veteriner',
		};
		expect(asAppointment(mention, 'Biscuit', 'tr')).toEqual({
			kind: 'pets.treatment',
			title: 'Biscuit · Aşı randevusu',
			quote: 'biscuit aşı randevusu saat 10',
			date: { text: 'yarın', inDays: 1 },
			time: '10:00',
			timeText: 'saat 10',
			place: 'Veteriner',
		});
		expect(
			asAppointment({ ...mention, title: "Biscuit's vaccination" }, 'Biscuit', 'en').title,
		).toBe("Biscuit's vaccination");
		expect(asAppointment({ kind: 'pets.treatment' }, 'Biscuit', 'en').title).toBe('Biscuit');
	});
});
