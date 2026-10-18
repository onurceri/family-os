import type { Actor, DigestOutput, MemberId } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dutyDueDays } from '../src/server/digest.ts';
import { CAR, createKernel, type Person, person } from './support.ts';

// The clock stands at Tuesday 6 October 2026.
let k: TestKernel;
let mara: Person;
let leo: Person;

beforeEach(async () => {
	({ k } = await createKernel());
	mara = await person(k, 'admin', 'Mara');
	leo = await person(k, 'member', 'Leo');
});
afterEach(() => k.close());

const ai = (p: Person = mara, roleId = 'admin'): Actor => ({
	kind: 'ai',
	mode: 'conversation',
	source: 'assistant',
	onBehalfOf: p.id as MemberId,
	roleId,
});
const duty = (input: Record<string, unknown>) =>
	k.runner.invoke(
		'records.addObligation',
		{ recordId: CAR, recordKind: 'vehicle', recordName: 'Family car', ...input },
		mara.actor,
	);
const digest = async (input: Record<string, unknown>, actor: Actor = ai()) => {
	const result = await k.runner.invoke<DigestOutput>('records.digest', input, actor);
	if (result.status !== 'applied') throw new Error('expected a read');
	return result.output;
};
const days = (out: DigestOutput) => out.items.map((i) => `${i.date} ${i.title}`);

describe('dutyDueDays', () => {
	const once = { rrule: null, rrule_start: null, lapses: 0 };
	it('counts a late duty only when the span holds today, and never a date that only passes', () => {
		const late = { ...once, due_date: '2026-09-30' };
		expect(dutyDueDays(late, '2026-10-06', '2026-10-12', '2026-10-06')).toEqual(['2026-09-30']);
		expect(dutyDueDays(late, '2026-10-12', '2026-10-18', '2026-10-06')).toEqual([]);
		expect(dutyDueDays({ ...late, lapses: 1 }, '2026-10-06', '2026-10-12', '2026-10-06')).toEqual(
			[],
		);
	});

	it('lists every date of a monthly duty in the span', () => {
		const monthly = {
			...once,
			due_date: '2026-10-15',
			rrule: 'FREQ=MONTHLY;INTERVAL=1',
			rrule_start: '2026-01-15',
		};
		expect(dutyDueDays(monthly, '2026-10-06', '2026-12-06', '2026-10-06')).toEqual([
			'2026-10-15',
			'2026-11-15',
		]);
	});
});

describe('records.digest', () => {
	it('holds the duties due in the span, with the record, notes and what is late today', async () => {
		await duty({ title: 'Inspection', dueDate: '2026-10-01', notes: 'Bring the papers' });
		await duty({ title: 'Insurance', dueDate: '2026-10-09', every: { years: 1 } });
		await duty({ title: 'Tyres', dueDate: '2026-10-20' });
		const out = await digest({ from: '2026-10-06', to: '2026-10-12' });
		expect(days(out)).toEqual(['2026-10-01 Inspection', '2026-10-09 Insurance']);
		expect(out.items[0]).toMatchObject({
			kind: 'duty',
			status: 'overdue',
			notes: 'Bring the papers',
			extra: { record: 'Family car', recordId: CAR },
		});
		expect(out.items[1]?.extra).toMatchObject({ repeats: 'yes' });
		expect(out.items[1]?.status).toBeUndefined();
	});

	it('keeps the duties of the people asked about and the ones nobody is assigned', async () => {
		await duty({ title: 'Leo renews', dueDate: '2026-10-08', assigneeId: leo.id });
		await duty({ title: 'Mara renews', dueDate: '2026-10-08', assigneeId: mara.id });
		await duty({ title: 'Anyone renews', dueDate: '2026-10-08' });
		const out = await digest({ from: '2026-10-08', to: '2026-10-08', memberIds: [leo.id] });
		expect(out.items.map((i) => i.title).sort()).toEqual(['Anyone renews', 'Leo renews']);
	});

	it('ranks by the words asked about and keeps every duty', async () => {
		await duty({ title: 'Service', dueDate: '2026-10-08' });
		await duty({ title: 'Insurance', dueDate: '2026-10-08' });
		const out = await digest({ from: '2026-10-08', to: '2026-10-08', about: ['insurance'] });
		expect(out.items.map((i) => i.title)).toEqual(['Insurance', 'Service']);
	});

	it('says which duty comes next when the span has none', async () => {
		await duty({ title: 'Inspection', dueDate: '2027-03-01' });
		const out = await digest({ from: '2026-10-06', to: '2026-10-12' });
		expect(out.items).toEqual([]);
		expect(out.nextAfter).toMatchObject({ title: 'Inspection', date: '2027-03-01' });
	});

	it('cuts a crowded span and says so', async () => {
		for (let i = 0; i < 61; i++) await duty({ title: `Duty ${i}`, dueDate: '2026-10-08' });
		const out = await digest({ from: '2026-10-08', to: '2026-10-08' });
		expect(out.items).toHaveLength(60);
		expect(out.truncated).toBe(true);
	});

	it('gives nothing to an AI whose area is off', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'records', access: 'off' },
			mara.actor,
		);
		await expect(
			k.runner.invoke('records.digest', { from: '2026-10-06', to: '2026-10-12' }, ai()),
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('records.digest links', () => {
	it('carries the page of the record a duty is for, and nothing when the owner gave none', async () => {
		await duty({ title: 'Inspection', dueDate: '2026-10-07', recordUrl: `/vehicles/${CAR}` });
		await duty({ title: 'Tyres', dueDate: '2026-10-08' });
		const out = await digest({ from: '2026-10-06', to: '2026-10-12' });
		expect(out.items.find((i) => i.title === 'Inspection')?.href).toBe(`/vehicles/${CAR}`);
		expect(out.items.find((i) => i.title === 'Tyres')?.href).toBeUndefined();
	});
});
