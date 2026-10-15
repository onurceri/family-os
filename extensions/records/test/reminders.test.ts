import { systemActor } from '@famos/sdk';
import type { FakeChannel, TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Obligation } from '../src/contract/index.ts';
import { applied, at, CAR, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let channel: FakeChannel;
let ann: Person;
let bob: Person;
let kid: Person;

beforeEach(async () => {
	({ k, channel } = await createKernel());
	ann = await person(k, 'admin', 'Ann');
	bob = await person(k, 'member', 'Bob');
	kid = await person(k, 'supervised', 'Kid');
});
afterEach(() => k.close());

const add = (input: Record<string, unknown>) =>
	applied<Obligation>(
		k,
		'records.addObligation',
		{
			recordId: CAR,
			recordKind: 'vehicle',
			recordName: 'Golf',
			recordUrl: `/vehicles/${CAR}`,
			title: 'Traffic insurance',
			dueDate: '2026-10-30',
			...input,
		},
		ann.actor,
	);
async function advanceTo(ms: number) {
	k.clock.set(ms);
	await k.worker.drain();
}
const sent = () => channel.sent.filter((s) => s.message.title.includes('obligation_due_title'));

describe('obligation reminders', () => {
	it('says a lapsing date ends rather than is due', async () => {
		await add({ assigneeId: bob.id, leadDays: 14, lapses: true });
		await advanceTo(at('2026-10-16', '09:00'));
		await advanceTo(at('2026-10-30', '09:00'));
		expect(sent().map((s) => s.message.body)).toEqual([
			'en|records:obligation_ends_in|{"count":14,"date":"30 Oct 2026"}',
			'en|records:obligation_ends_today|{}',
		]);
	});

	it('reminds the assignee at the lead time and again on the due date, once each', async () => {
		await add({ assigneeId: bob.id, leadDays: 14 });
		await advanceTo(at('2026-10-16', '09:00') - 1);
		expect(sent()).toHaveLength(0);
		await advanceTo(at('2026-10-16', '09:00'));
		expect(sent()).toHaveLength(1);
		expect(sent()[0]).toMatchObject({
			memberId: bob.id,
			message: {
				title: 'en|records:obligation_due_title|{"title":"Traffic insurance","record":"Golf"}',
				body: 'en|records:obligation_due_in|{"count":14,"date":"30 Oct 2026"}',
				url: `/vehicles/${CAR}`,
			},
		});
		// Nothing more until the due day, and running the worker again sends nothing twice.
		await advanceTo(at('2026-10-29', '12:00'));
		await k.worker.drain();
		expect(sent()).toHaveLength(1);
		await advanceTo(at('2026-10-30', '09:00'));
		await k.worker.drain();
		expect(sent()).toHaveLength(2);
		expect(sent()[1]?.message.body).toBe('en|records:obligation_due_today|{}');
		expect(sent().every((s) => s.memberId === bob.id)).toBe(true);
	});

	it('reminds everyone who holds the audience capability when nobody is assigned', async () => {
		await add({ audience: 'records.edit', leadDays: 0 });
		await advanceTo(at('2026-10-30', '09:00'));
		const who = sent().map((s) => s.memberId);
		expect(who).toEqual(expect.arrayContaining([ann.id, bob.id]));
		expect(who).not.toContain(kid.id);
		expect(sent()).toHaveLength(2);
	});

	it('reaches everyone who may see records by default', async () => {
		await add({ leadDays: 0 });
		await advanceTo(at('2026-10-30', '09:00'));
		expect(sent().map((s) => s.memberId)).toEqual(expect.arrayContaining([ann.id, bob.id, kid.id]));
	});

	it('falls back to the people who may see records when the audience is unknown', async () => {
		await add({ audience: 'garage.view', leadDays: 0 });
		await advanceTo(at('2026-10-30', '09:00'));
		expect(sent().length).toBeGreaterThanOrEqual(2);
	});

	it('plans only the due-date reminder when the lead time has already begun', async () => {
		await add({ dueDate: '2026-10-11', leadDays: 14, assigneeId: bob.id });
		await advanceTo(at('2026-10-10', '12:00'));
		expect(sent()).toHaveLength(0);
		await advanceTo(at('2026-10-11', '09:00'));
		expect(sent()).toHaveLength(1);
	});

	it('follows a changed due date and ignores the old one', async () => {
		const o = await add({ assigneeId: bob.id, leadDays: 0 });
		await applied(
			k,
			'records.updateObligation',
			{
				id: o.id,
				obligation: { title: o.title, dueDate: '2026-11-10', leadDays: 0, assigneeId: bob.id },
			},
			ann.actor,
		);
		await advanceTo(at('2026-10-30', '12:00'));
		expect(sent()).toHaveLength(0);
		await advanceTo(at('2026-11-10', '09:00'));
		expect(sent()).toHaveLength(1);
	});

	it('plans the next due date after a completion, not the old one', async () => {
		const o = await add({ assigneeId: bob.id, leadDays: 0, every: { years: 1 } });
		await applied(k, 'records.completeObligation', { id: o.id }, ann.actor);
		await advanceTo(at('2026-11-01', '12:00'));
		expect(sent()).toHaveLength(0);
		await advanceTo(at('2027-10-30', '09:00'));
		expect(sent()).toHaveLength(1);
	});

	it('sends nothing for an obligation that was removed, finished or archived with its record', async () => {
		const gone = await add({ title: 'Gone', assigneeId: bob.id, leadDays: 0 });
		const done = await add({ title: 'Done', assigneeId: bob.id, leadDays: 0 });
		await add({ title: 'Archived', assigneeId: bob.id, leadDays: 0, dueDate: '2026-10-30' });
		await applied(k, 'records.removeObligation', { id: gone.id }, ann.actor);
		await applied(k, 'records.completeObligation', { id: done.id }, ann.actor);
		await applied(k, 'records.archiveForRecord', { recordId: CAR }, ann.actor);
		await advanceTo(at('2026-10-30', '12:00'));
		expect(sent()).toHaveLength(0);
	});

	it('still reminds after the record was renamed', async () => {
		await add({ assigneeId: bob.id, leadDays: 0 });
		await applied(k, 'records.renameRecord', { recordId: CAR, name: 'Polo' }, ann.actor);
		await advanceTo(at('2026-10-30', '09:00'));
		expect(sent()).toHaveLength(1);
		expect(sent()[0]?.message.title).toContain('"record":"Polo"');
	});

	it('does not remind about a day that has passed when the server was down', async () => {
		await add({ assigneeId: bob.id, leadDays: 0 });
		await advanceTo(at('2026-11-02', '08:00'));
		expect(sent()).toHaveLength(0);
	});

	it("writes the date in each reader's language with the family's region format", async () => {
		await k.runner.invoke('core.updateFamilySettings', { formatLocale: 'sl-SI' }, systemActor('t'));
		const reader = async (locale: string) => {
			const r = await k.runner.invoke<{ id: string }>(
				'core.createMember',
				{ displayName: `Reader ${locale}`, roleId: 'member', locale },
				systemActor('t'),
			);
			if (r.status !== 'applied') throw new Error('expected member');
			return r.output.id;
		};
		const english = await reader('en');
		const turkish = await reader('tr');
		await add({ assigneeId: english, leadDays: 14 });
		await add({ assigneeId: turkish, leadDays: 14, title: 'Inspection' });
		await advanceTo(at('2026-10-16', '09:00'));
		const bodies = Object.fromEntries(sent().map((s) => [s.memberId, s.message.body]));
		// English words in the Slovenian order, never "30. okt. 2026" for an English reader.
		expect(bodies[english]).toBe('en|records:obligation_due_in|{"count":14,"date":"30 Oct 2026"}');
		expect(bodies[turkish]).toBe('tr|records:obligation_due_in|{"count":14,"date":"30 Eki 2026"}');
	});
});
