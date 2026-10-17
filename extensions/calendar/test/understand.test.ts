import { type Mention, type Resolution, systemActor } from '@famos/sdk';
import {
	createTestClock,
	createTestKernel,
	resolveMentions,
	SHARE_AI,
	type TestKernel,
} from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import calendar from '../src/server/index.ts';

// Tuesday 6 October 2026, 10:00 UTC.
const TODAY = Date.UTC(2026, 9, 6, 10, 0);

let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar], clock: createTestClock(TODAY) });
	admin = await k.member('admin', 'Mara');
});
afterEach(() => k.close());

const settings = (change: Record<string, unknown>) =>
	k.runner.invoke('core.updateFamilySettings', change, systemActor('test'));

async function addEvent(input: Record<string, unknown>): Promise<{ id: string }> {
	const result = await k.runner.invoke('calendar.createEvent', input, admin.actor);
	if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
	return result.output as { id: string };
}

/** The weekly football training on Thursdays, 17:30 to 19:00, since 1 October. */
const footballTraining = () =>
	addEvent({
		title: 'Football training',
		date: '2026-10-01',
		startTime: '17:30',
		endTime: '19:00',
		recurrence: { freq: 'weekly', byDay: ['TH'] },
	});

const resolve = (
	kind: string,
	mentions: Omit<Mention, 'kind'>[],
	env: { text?: string | null; sharer?: string | null } = {},
) =>
	resolveMentions(
		k,
		kind,
		mentions.map((m) => ({ ...m, kind })),
		{ text: null, sharer: null, ...env },
	);

const proposal = (resolution: Resolution | undefined) => {
	if (!resolution || !('propose' in resolution)) throw new Error('expected a suggestion');
	return resolution.propose;
};

/** Drafts what a resolution proposes, the way the AI pipeline would, and returns the status. */
async function draft(resolution: Resolution | undefined) {
	const { actionId, input, uncertain } = proposal(resolution);
	const result = await k.ctx.actions.invoke(actionId, input, SHARE_AI, {
		draft: { uncertainFields: [...(uncertain ?? [])] },
	});
	return result.status;
}

describe('the calendar kinds', () => {
	it('are offered to the AI', () => {
		expect(
			k.ctx.actions
				.aiKinds()
				.map((kind) => kind.id)
				.toSorted(),
		).toEqual(['calendar.event', 'calendar.eventCancel', 'calendar.eventChange']);
	});
});

describe('calendar.event', () => {
	it('reads the day, the time and the people the message names', async () => {
		const ivy = await k.member('supervised', 'Ivy');
		const out = await resolve(
			'calendar.event',
			[
				{
					title: 'Dentist',
					people: ['Ivy'],
					date: { text: 'next Thursday', weekday: 4, week: 'next' },
					time: '16:30',
					timeText: '4:30pm',
					place: 'Riverside clinic',
				},
			],
			{ text: 'Ivy has the dentist next Thursday at 4:30pm at the Riverside clinic' },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'calendar.createEvent',
					input: {
						title: 'Dentist',
						startTime: '16:30',
						date: '2026-10-15',
						memberIds: [ivy.member.id],
						location: 'Riverside clinic',
					},
					subject: 'Dentist',
					// "Next Thursday" names a weekday, not a date: a person checks the week.
					uncertain: ['date'],
					from: [0],
				},
			},
		]);
		expect(await draft(out[0])).toBe('drafted');
	});

	it('makes an event without a time all day, and asks for the time to be checked', async () => {
		const out = await resolve(
			'calendar.event',
			[
				{
					title: 'Choir rehearsal',
					date: { text: 'Thursday', weekday: 4 },
					notes: 'Bring your folder',
				},
			],
			{ text: 'Choir rehearsal moved to Thursday, bring your folder' },
		);
		expect(proposal(out[0])).toEqual({
			actionId: 'calendar.createEvent',
			input: {
				title: 'Choir rehearsal',
				allDay: true,
				date: '2026-10-08',
				memberIds: [],
				notes: 'Bring your folder',
			},
			subject: 'Choir rehearsal',
			uncertain: ['date', 'startTime', 'allDay'],
			from: [0],
		});
		expect(await draft(out[0])).toBe('drafted');
	});

	it('replays weekly lessons with an end: the series runs to the end of the month the words name', async () => {
		await settings({ timeZone: 'Europe/Istanbul', locale: 'tr' });
		const deniz = await k.member('supervised', 'Deniz');
		const text =
			"Deniz'in piyano dersi her çarşamba saat 17:00'de, Ekim sonuna kadar devam edecek.";
		// The model counted to the last Wednesday of October for the end.
		const out = await resolve(
			'calendar.event',
			[
				{
					title: 'Piyano dersi',
					people: ['Deniz'],
					date: { text: 'her çarşamba', weekday: 3 },
					time: '17:00',
					timeText: 'saat 17:00',
					repeat: {
						every: 'week',
						weekdays: [3],
						until: { text: 'Ekim sonuna kadar', day: 28, month: 10 },
					},
				},
			],
			{ text },
		);
		expect(proposal(out[0])).toEqual({
			actionId: 'calendar.createEvent',
			input: {
				title: 'Piyano dersi',
				startTime: '17:00',
				date: '2026-10-07',
				memberIds: [deniz.member.id],
				recurrence: { freq: 'weekly', interval: 1, byDay: ['WE'], until: '2026-10-31' },
			},
			subject: 'Piyano dersi',
			from: [0],
		});
		expect(await draft(out[0])).toBe('drafted');
	});

	it('starts a series on its own weekday, and ends a counted one on its last date', async () => {
		const out = await resolve('calendar.event', [
			{
				title: 'Swimming lessons',
				time: '18:00',
				repeat: { every: 'week', weekdays: [1, 3], count: 4 },
			},
			{
				title: 'Book club',
				date: { text: 'the 20th', day: 20 },
				time: '19:00',
				repeat: { every: 'month', until: { text: 'until the end of the year', approximate: true } },
			},
		]);
		expect(proposal(out[0]).input).toMatchObject({
			date: '2026-10-07',
			recurrence: { freq: 'weekly', interval: 1, byDay: ['MO', 'WE'], until: '2026-10-19' },
		});
		// "The end of the year" names no month: the end is a guess for a person to check.
		expect(proposal(out[1])).toMatchObject({
			input: { date: '2026-10-20', recurrence: { freq: 'monthly', interval: 1 } },
			uncertain: ['recurrence'],
		});
	});

	it('replays the parents’ evening letter: the event the calendar has is not suggested again', async () => {
		await settings({ timeZone: 'Europe/Ljubljana' });
		await addEvent({ title: "Parents' evening at school", date: '2026-10-20', startTime: '18:00' });
		const text =
			"Dear parents, Year 7 class trip to Postojna Cave is on Thursday 29 October. Bus leaves school at 7:50. Parents' evening moved to 20 October, 18:00 in the school hall.";
		const out = await resolve(
			'calendar.event',
			[
				{
					title: 'Class trip to Postojna Cave',
					date: { text: 'Thursday 29 October', day: 29, month: 10, weekday: 4 },
					time: '07:50',
					timeText: '7:50',
				},
				{
					title: "Parents' evening",
					date: { text: '20 October', day: 20, month: 10 },
					time: '18:00',
					timeText: '18:00',
					place: 'School hall',
				},
			],
			{ text },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'calendar.createEvent',
					input: {
						title: 'Class trip to Postojna Cave',
						startTime: '07:50',
						date: '2026-10-29',
						memberIds: [],
					},
					subject: 'Class trip to Postojna Cave',
					from: [0],
				},
			},
			{ refuse: { reason: 'already', subject: "Parents' evening", from: [1] } },
		]);
		// Read as a change instead, only the new place is suggested; with nothing new, nothing is.
		const change = await resolve(
			'calendar.eventChange',
			[
				{
					target: "Parents' evening",
					date: { text: '20 October', day: 20, month: 10 },
					time: '18:00',
					place: 'School hall',
				},
				{ target: "Parents' evening", date: { text: '20 October', day: 20, month: 10 } },
			],
			{ text },
		);
		expect(proposal(change[0]).input).toEqual({
			id: expect.any(String),
			location: 'School hall',
			label: "Parents' evening",
		});
		expect(change[1]).toEqual({
			refuse: { reason: 'already', subject: "Parents' evening", from: [1] },
		});
	});

	it('suggests an event of the same name on another day, where the runner offers the move', async () => {
		await addEvent({ title: 'Regional Gala', date: '2026-11-07', startTime: '18:00' });
		const out = await resolve('calendar.event', [
			{
				title: 'Regional gala',
				date: { text: 'Sat 14 Nov', day: 14, month: 11, weekday: 6 },
				time: '09:00',
			},
		]);
		expect(proposal(out[0]).input).toMatchObject({ date: '2026-11-14', startTime: '09:00' });
		expect(await draft(out[0])).toBe('drafted');
	});

	it('doubts an event given to the sharer alone when the message names nobody', async () => {
		await k.member('member', 'Tom');
		const out = await resolve(
			'calendar.event',
			[
				{
					title: 'Check-up',
					forMe: true,
					date: { text: 'Saturday 10 October', day: 10, month: 10, weekday: 6 },
					time: '09:00',
					timeText: '9am',
				},
			],
			{
				text: 'Note to self: my dentist check-up is on Saturday 10 October at 9am.',
				sharer: admin.member.id,
			},
		);
		expect(proposal(out[0])).toMatchObject({
			input: { memberIds: [admin.member.id], date: '2026-10-10', startTime: '09:00' },
			uncertain: ['memberIds'],
		});
	});

	it('reuses the family’s own tags and keeps two at most', async () => {
		await addEvent({ title: 'Match', date: '2026-10-10', startTime: '10:00', tags: ['Sport'] });
		const out = await resolve('calendar.event', [
			{
				title: 'Tournament',
				date: { text: '17 October', day: 17, month: 10 },
				tags: ['sport', 'Sport', 'School', 'Extra'],
			},
		]);
		expect(proposal(out[0]).input).toMatchObject({ tags: ['Sport', 'School'] });
	});

	it('refuses an event with no title or no day', async () => {
		const out = await resolve('calendar.event', [
			{ date: { text: 'Friday', weekday: 5 } },
			{ title: 'Party', time: '15:00' },
		]);
		expect(out).toEqual([
			{ refuse: { reason: 'incomplete', subject: null, from: [0] } },
			{ refuse: { reason: 'incomplete', subject: 'Party', from: [1] } },
		]);
	});
});

describe('calendar.eventChange', () => {
	it('moves the event the message names to its new day and time', async () => {
		const gala = await addEvent({ title: 'Regional Gala', date: '2026-11-07', startTime: '18:00' });
		const out = await resolve(
			'calendar.eventChange',
			[
				{
					target: 'Regional gala',
					date: { text: 'Sat 14 Nov', day: 14, month: 11, weekday: 6 },
					time: '09:00',
					timeText: '09:00',
				},
			],
			{ text: 'Regional gala moved to Sat 14 Nov 09:00' },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'calendar.changeEvent',
					input: { id: gala.id, date: '2026-11-14', startTime: '09:00', label: 'Regional gala' },
					subject: 'Regional gala',
					targetTitle: 'Regional Gala',
					from: [0],
				},
			},
		]);
		expect(await draft(out[0])).toBe('drafted');
	});

	it('moves the one date of a repeating event nearest the new day', async () => {
		const training = await footballTraining();
		const out = await resolve(
			'calendar.eventChange',
			[{ target: 'football', date: { text: 'Friday', weekday: 5 } }],
			{ text: 'football is on friday this week' },
		);
		expect(proposal(out[0])).toMatchObject({
			input: {
				id: training.id,
				occurrence: String(Date.UTC(2026, 9, 8, 17, 30)),
				date: '2026-10-09',
				label: 'football',
			},
			targetTitle: 'Football training',
			uncertain: ['date'],
		});
		expect(await draft(out[0])).toBe('drafted');
	});

	it('changes the time of a whole series when no day is named', async () => {
		const training = await footballTraining();
		const out = await resolve('calendar.eventChange', [
			{ target: 'Football training', time: '18:00', endTime: '19:30' },
		]);
		expect(proposal(out[0]).input).toEqual({
			id: training.id,
			startTime: '18:00',
			endTime: '19:30',
			label: 'Football training',
		});
	});

	it('finds nothing to change when no event fits, or several do', async () => {
		await addEvent({ title: 'Football training', date: '2026-10-08', startTime: '17:30' });
		await addEvent({ title: 'Football match', date: '2026-10-10', startTime: '10:00' });
		const out = await resolve(
			'calendar.eventChange',
			[
				{ target: 'piano recital', time: '18:00' },
				{ target: 'football', time: '18:00' },
				{ target: 'Football match' },
			],
			{ text: 'football is at 18:00 now, and the piano recital too' },
		);
		expect(out).toEqual([
			{ refuse: { reason: 'unknown', subject: 'piano recital', from: [0] } },
			{ refuse: { reason: 'ambiguous', subject: 'football', from: [1] } },
			{ refuse: { reason: 'incomplete', subject: 'Football match', from: [2] } },
		]);
	});
});

describe('calendar.eventCancel', () => {
	it('replays "football thursday was cancelled": only that date of the training goes', async () => {
		const training = await footballTraining();
		const out = await resolve(
			'calendar.eventCancel',
			[{ target: 'football', date: { text: 'thursday', weekday: 4 } }],
			{
				text: 'um so football thursday was cancelled?? coach said tell mum, also i need a new ball and ice cream pls thx',
			},
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'calendar.deleteEvent',
					input: {
						id: training.id,
						occurrence: String(Date.UTC(2026, 9, 8, 17, 30)),
						label: 'football',
					},
					subject: 'football',
					targetTitle: 'Football training',
					from: [0],
				},
			},
		]);
		expect(await draft(out[0])).toBe('drafted');
	});

	it('reads a weekday named on that day after the event as next week’s', async () => {
		await footballTraining();
		k.clock.set(Date.UTC(2026, 9, 8, 20, 0));
		const out = await resolve('calendar.eventCancel', [
			{ target: 'football', date: { text: 'thursday', weekday: 4 } },
		]);
		expect(proposal(out[0]).input).toMatchObject({
			occurrence: String(Date.UTC(2026, 9, 15, 17, 30)),
		});
	});

	it('says a date already taken out is off already, and merges two mentions of one date', async () => {
		const training = await footballTraining();
		await k.runner.invoke(
			'calendar.deleteEvent',
			{ id: training.id, occurrence: '2026-10-08' },
			admin.actor,
		);
		const out = await resolve('calendar.eventCancel', [
			{ target: 'football', date: { text: '8 October', day: 8, month: 10 } },
			{ target: 'football training', date: { text: '15 October', day: 15, month: 10 } },
			{ target: 'Football', date: { text: 'the 15th', day: 15 } },
		]);
		expect(out).toEqual([
			{ refuse: { reason: 'already', subject: 'football', from: [0] } },
			{
				propose: {
					actionId: 'calendar.deleteEvent',
					input: {
						id: training.id,
						occurrence: String(Date.UTC(2026, 9, 15, 17, 30)),
						label: 'football training',
					},
					subject: 'football training',
					targetTitle: 'Football training',
					from: [1, 2],
				},
			},
		]);
	});

	it('cancels a one-off event whole, and the next date of a series when no day is named', async () => {
		const recital = await addEvent({
			title: 'Piano recital',
			date: '2026-10-20',
			startTime: '18:00',
		});
		const training = await footballTraining();
		const out = await resolve('calendar.eventCancel', [
			{ target: 'piano recital' },
			{ target: 'football training' },
		]);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'calendar.deleteEvent',
					input: { id: recital.id, label: 'piano recital' },
					subject: 'piano recital',
					targetTitle: 'Piano recital',
					from: [0],
				},
			},
			{
				propose: {
					actionId: 'calendar.deleteEvent',
					input: {
						id: training.id,
						occurrence: String(Date.UTC(2026, 9, 8, 17, 30)),
						label: 'football training',
					},
					subject: 'football training',
					targetTitle: 'Football training',
					uncertain: ['occurrence'],
					from: [1],
				},
			},
		]);
	});

	it('takes at most a few cancellations from one message', async () => {
		await footballTraining();
		const out = await resolve(
			'calendar.eventCancel',
			Array.from({ length: 6 }, (_, i) => ({
				target: 'football',
				date: { text: `${8 + 7 * i} days`, inDays: 2 + 7 * i },
			})),
		);
		expect(out.filter((r) => 'propose' in r)).toHaveLength(4);
		expect(out.slice(4)).toEqual([
			{ refuse: { reason: 'incomplete', subject: 'football', from: [4] } },
			{ refuse: { reason: 'incomplete', subject: 'football', from: [5] } },
		]);
	});
});
