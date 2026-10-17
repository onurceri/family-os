import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { storedAsWhole, wholeRecord } from '../src/whole-record.ts';

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

describe('storedAsWhole', () => {
	it('reads a body stored before as the old code did: left out is empty, or its default', () => {
		const upgrade = storedAsWhole(Fields, 'task');
		const upgraded = upgrade({ id: 'x', task: { title: 'Walk', due: '2026-10-20' } });
		expect(upgraded).toEqual({
			id: 'x',
			task: { title: 'Walk', notes: null, place: null, kind: 'a', due: '2026-10-20', time: null },
		});
		expect(Whole.safeParse((upgraded as { task: unknown }).task).success).toBe(true);
	});

	it('keeps what was sent, and leaves anything that is not a record for the schema', () => {
		const upgrade = storedAsWhole(Fields);
		expect(upgrade({ title: 'Walk', kind: 'b', notes: 'n' })).toMatchObject({
			kind: 'b',
			notes: 'n',
		});
		expect(upgrade('nonsense')).toBe('nonsense');
		expect(storedAsWhole(Fields, 'task')({ id: 'x' })).toEqual({ id: 'x', task: undefined });
	});
});
