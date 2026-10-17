import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { wholeRecord } from '../src/whole-record.ts';

const Fields = z
	.object({
		title: z.string().min(1),
		notes: z.string().nullable().optional().describe('Notes'),
		place: z.string().optional(),
		kind: z.enum(['a', 'b']).default('a'),
		due: z.string().nullable().optional(),
		time: z.string().nullable().optional(),
	})
	.superRefine((v, ctx) => {
		if (v.time && !v.due) ctx.addIssue({ code: 'custom', path: ['time'], message: 'needs due' });
	});

const Whole = wholeRecord(Fields);
const issues = (input: unknown) =>
	Whole.safeParse(input).error?.issues.map((i) => i.path.join('.')) ?? [];

describe('wholeRecord', () => {
	it('refuses a body that leaves fields out, naming each one', () => {
		expect(issues({ title: 'Walk' })).toEqual(['notes', 'place', 'kind', 'due', 'time']);
	});

	it('takes null to clear what create lets you leave out, and never fills in a default', () => {
		const whole = { title: 'Walk', notes: null, place: null, kind: 'b', due: null, time: null };
		expect(Whole.parse(whole)).toEqual(whole);
		expect(issues({ ...whole, kind: null })).toEqual(['kind']);
	});

	it('keeps the refinements and the descriptions', () => {
		const whole = { title: 'Walk', notes: null, place: null, kind: 'a', due: null, time: '09:00' };
		expect(issues(whole)).toEqual(['time']);
		expect(Whole.shape.notes.description).toBe('Notes');
		expect(z.toJSONSchema(Whole).required).toEqual([
			'title',
			'notes',
			'place',
			'kind',
			'due',
			'time',
		]);
	});
});
