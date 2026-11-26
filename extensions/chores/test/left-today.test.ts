import { type Actor, systemActor } from '@famos/sdk';
import type { TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chore } from '../src/contract/index.ts';
import { LEFT_TODAY_JOB } from '../src/server/left-today.ts';
import { applied, at, createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let channel: Awaited<ReturnType<typeof createKernel>>['channel'];
let ayse: Person; // admin
let bora: Person; // member
let cem: Person; // member who never switches it on

beforeEach(async () => {
	({ k, channel } = await createKernel());
	ayse = await person(k, 'admin', 'Ayşe');
	bora = await person(k, 'member', 'Bora');
	cem = await person(k, 'member', 'Cem');
	await switchOn(ayse.actor);
	await switchOn(bora.actor);
});
afterEach(() => k.close());

const TODAY = '2026-10-06';

const switchOn = (actor: Actor) =>
	k.runner.invoke(
		'core.setNotificationPreferences',
		{ kinds: { 'chores.leftToday': { web: true } }, quietHours: null },
		actor,
	);
const create = (input: Record<string, unknown>) =>
	applied<Chore>(
		k,
		'chores.createChore',
		{ title: 'Dishes', startDate: TODAY, assigneeIds: [ayse.id], ...input },
		ayse.actor,
	);
const advanceTo = async (ms: number) => {
	k.clock.set(ms);
	await k.worker.drain();
};
const setTimes = (times: string[]) => applied(k, 'chores.setLeftTodayTimes', { times }, ayse.actor);
const sent = () => channel.sent.filter((s) => s.message.title.includes('left_today_title'));
const told = () => sent().map((s) => [s.memberId, s.message.title]);
const title = (count: number) => `en|chores:left_today_title|${JSON.stringify({ count })}`;
const planned = async () =>
	(
		await k.ctx.db
			.withTables<{
				queue_jobs: { name: string; status: string; run_at: number };
			}>()
			.selectFrom('queue_jobs')
			.select('run_at')
			.where('name', '=', LEFT_TODAY_JOB)
			.where('status', '=', 'pending')
			.execute()
	).map((r) => r.run_at);
const inApp = async (actor: Actor) =>
	(await k.route('core.listNotifications').call({ actor })).items.filter(
		(i: { kind: string }) => i.kind === 'chores.leftToday',
	);

describe('chores still open in the evening', () => {
	it('tells each person who switched it on how many of theirs are open, at 18:00, once', async () => {
		await create({ title: 'Dishes' });
		await create({ title: 'Plants', startDate: '2026-10-04' }); // late
		await create({ title: 'Trash', assigneeIds: [bora.id] });
		await create({ title: 'Later', startDate: '2026-10-07' });
		await create({ title: 'Cem', assigneeIds: [cem.id] });

		await advanceTo(at(TODAY, '17:59'));
		expect(sent()).toEqual([]);
		await advanceTo(at(TODAY, '18:00'));
		expect(told()).toEqual([
			[ayse.id, title(2)],
			[bora.id, title(1)],
		]);
		expect(sent()[0]?.message).toMatchObject({
			body: 'en|chores:left_today_body|{}',
			url: '/chores',
		});
		// Cem did not switch it on: nothing at all, not even in the app.
		expect(await inApp(cem.actor)).toEqual([]);
		expect(await inApp(ayse.actor)).toHaveLength(1);

		await advanceTo(at(TODAY, '23:00'));
		expect(sent()).toHaveLength(2);
	});

	it('tells nobody twice on the same day, even when the count runs again', async () => {
		await create({ title: 'Dishes' });
		await advanceTo(at(TODAY, '18:00'));
		await k.ctx.enqueue(LEFT_TODAY_JOB, { at: at(TODAY, '18:00') }, { runAt: at(TODAY, '18:30') });
		await advanceTo(at(TODAY, '18:30'));
		expect(told()).toEqual([[ayse.id, title(1)]]);
		expect(await inApp(ayse.actor)).toHaveLength(1);
	});

	it('tells nobody who has left the family', async () => {
		await create({ title: 'Trash', assigneeIds: [bora.id] });
		await applied(k, 'core.archiveMember', { memberId: bora.id }, ayse.actor);
		await advanceTo(at(TODAY, '18:00'));
		expect(sent()).toEqual([]);
	});

	it('leaves out chores anyone may do, archived ones and ones done today', async () => {
		await create({ title: 'Anyone', assigneeIds: [] });
		const gone = await create({ title: 'Gone' });
		await applied(k, 'chores.archiveChore', { id: gone.id }, ayse.actor);
		const dishes = await create({ title: 'Dishes' });
		await applied(k, 'chores.markDone', { id: dishes.id, dueDate: TODAY }, ayse.actor);
		await advanceTo(at(TODAY, '18:00'));
		expect(sent()).toEqual([]);
	});

	it('comes again the next evening, with that day’s count', async () => {
		await create({ title: 'Dishes', recurrence: { freq: 'daily', interval: 1 } });
		await advanceTo(at(TODAY, '18:00'));
		expect(await planned()).toEqual([at('2026-10-07', '18:00')]);
		await create({ title: 'Plants', startDate: '2026-10-07' });
		await advanceTo(at('2026-10-07', '18:00'));
		expect(told()).toEqual([
			[ayse.id, title(1)],
			[ayse.id, title(2)],
		]);
		expect(await inApp(ayse.actor)).toHaveLength(2);
	});

	it('skips an evening the server slept through, and keeps the next one', async () => {
		await create({ title: 'Dishes' });
		await advanceTo(at('2026-10-07', '09:00'));
		expect(sent()).toEqual([]);
		expect(await planned()).toEqual([at('2026-10-07', '18:00')]);
		await advanceTo(at('2026-10-07', '18:00'));
		expect(told()).toEqual([[ayse.id, title(1)]]);
	});

	it('follows the family time zone, also after it changes', async () => {
		await create({ title: 'Dishes' });
		// Planned for 18:00 in Istanbul; the family moves to Lisbon, three hours behind.
		await advanceTo(at(TODAY, '12:00'));
		await k.runner.invoke(
			'core.updateFamilySettings',
			{ timeZone: 'Europe/Lisbon' },
			systemActor('test'),
		);
		const lisbon = epochOf(TODAY, '18:00', 'Europe/Lisbon');
		await advanceTo(at(TODAY, '18:00'));
		expect(sent()).toEqual([]);
		expect(await planned()).toEqual([lisbon]);
		await advanceTo(lisbon);
		expect(told()).toEqual([[ayse.id, title(1)]]);
		expect(await planned()).toEqual([epochOf('2026-10-07', '18:00', 'Europe/Lisbon')]);
	});

	describe('at the times the family chose', () => {
		it('comes at each of them, once per time and person, also when a count runs again', async () => {
			await create({ title: 'Dishes' });
			await setTimes(['18:00', '12:00']);
			await advanceTo(at(TODAY, '11:59'));
			expect(sent()).toEqual([]);
			await advanceTo(at(TODAY, '12:00'));
			expect(told()).toEqual([[ayse.id, title(1)]]);
			expect(await planned()).toEqual([at(TODAY, '18:00')]);
			await advanceTo(at(TODAY, '18:00'));
			expect(told()).toEqual([
				[ayse.id, title(1)],
				[ayse.id, title(1)],
			]);
			expect(await inApp(ayse.actor)).toHaveLength(2);
			expect(await planned()).toEqual([at('2026-10-07', '12:00')]);

			await k.ctx.enqueue(
				LEFT_TODAY_JOB,
				{ at: at(TODAY, '12:00') },
				{ runAt: at(TODAY, '18:30') },
			);
			await advanceTo(at(TODAY, '18:30'));
			expect(sent()).toHaveLength(2);
		});

		it('follows a changed time, and the count planned for the old time tells nobody', async () => {
			await create({ title: 'Dishes' });
			await advanceTo(at(TODAY, '10:00'));
			await setTimes(['20:00']);
			await advanceTo(at(TODAY, '18:00'));
			expect(sent()).toEqual([]);
			expect(await planned()).toEqual([at(TODAY, '20:00')]);
			await advanceTo(at(TODAY, '20:00'));
			expect(told()).toEqual([[ayse.id, title(1)]]);
			expect(await planned()).toEqual([at('2026-10-07', '20:00')]);
		});

		it('does not tell late for a time added earlier today', async () => {
			await create({ title: 'Dishes' });
			await advanceTo(at(TODAY, '15:00'));
			await setTimes(['12:00', '18:00']);
			expect(await planned()).toContain(at(TODAY, '18:00'));
			await advanceTo(at(TODAY, '18:00'));
			expect(told()).toEqual([[ayse.id, title(1)]]);
		});

		it('says nothing of yesterday for a count that slept past midnight', async () => {
			await create({ title: 'Dishes' });
			await setTimes(['09:00', '18:00']);
			await advanceTo(at(TODAY, '08:00'));
			await advanceTo(at('2026-10-07', '08:00'));
			expect(sent()).toEqual([]);
			expect(await planned()).toEqual([at('2026-10-07', '09:00')]);
			await advanceTo(at('2026-10-07', '09:00'));
			expect(told()).toEqual([[ayse.id, title(1)]]);
		});

		it('tells once, for the latest time that has come, when several were missed', async () => {
			await create({ title: 'Dishes' });
			await setTimes(['11:00', '12:00', '13:00']);
			await advanceTo(at(TODAY, '10:30'));
			await advanceTo(at(TODAY, '13:30'));
			expect(told()).toEqual([[ayse.id, title(1)]]);
		});
	});
});
