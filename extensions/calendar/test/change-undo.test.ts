import { systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar], translate: repoTranslate() });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-12', '09:00', TZ));
	admin = await k.member('admin', 'Ayse');
});
afterEach(() => k.close());

type Shown = {
	version?: number;
	allDay: boolean;
	date: string;
	endDate: string | null;
	startTime: string | null;
	endTime: string | null;
};
// The version moves with every write, so it is not part of how the event looks.
const show = async (id: string): Promise<Shown> => {
	const { version: _version, ...event } = (await k
		.route('calendar.getEvent')
		.call({ params: { eventId: id } })) as Shown;
	return event;
};

async function create(input: Record<string, unknown>): Promise<string> {
	const made = await k.runner.invoke<{ id: string }>('calendar.createEvent', input, admin.actor);
	if (made.status !== 'applied') throw new Error('expected applied');
	return made.output.id;
}

// The AI proposes the change, a person approves it, then takes it back.
async function changeThenUndo(id: string, change: Record<string, unknown>) {
	const proposed = await k.runner.invoke(
		'calendar.changeEvent',
		{ id, label: 'Dentist', ...change },
		{
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			onBehalfOf: admin.member.id as never,
			roleId: 'admin',
		},
		{ draft: { sourceKind: 'assistant', sourceId: 'turn_1' } },
	);
	if (proposed.status !== 'drafted') throw new Error('expected a draft');
	await k.runner.approveDraft(proposed.draftId, admin.actor);
	const changed = await show(id);
	await k.runner.undoDraft(proposed.draftId, admin.actor);
	return { changed, undone: await show(id) };
}

describe('taking back a change of an event', () => {
	it('puts an all-day event back after it became timed', async () => {
		const id = await create({ title: 'Dentist', allDay: true, date: '2026-10-20' });
		const before = await show(id);
		const { changed, undone } = await changeThenUndo(id, { allDay: false, startTime: '10:00' });
		expect(changed).toMatchObject({ allDay: false, startTime: '10:00' });
		expect(undone).toEqual(before);
	});

	it('puts a timed event back after it became all-day', async () => {
		const id = await create({
			title: 'Dentist',
			date: '2026-10-20',
			startTime: '10:00',
			endTime: '11:30',
		});
		const before = await show(id);
		const { changed, undone } = await changeThenUndo(id, { allDay: true });
		expect(changed).toMatchObject({ allDay: true, startTime: null });
		expect(undone).toEqual(before);
	});

	it('puts back a new time and a new day of a timed event', async () => {
		const id = await create({ title: 'Dentist', date: '2026-10-20', startTime: '10:00' });
		const before = await show(id);
		const { undone } = await changeThenUndo(id, { date: '2026-10-22', startTime: '15:00' });
		expect(undone).toEqual(before);
	});

	it('puts back a new day of an all-day event', async () => {
		const id = await create({ title: 'Dentist', allDay: true, date: '2026-10-20' });
		const before = await show(id);
		const { undone } = await changeThenUndo(id, { date: '2026-10-23', endDate: '2026-10-24' });
		expect(undone).toEqual(before);
	});
});
