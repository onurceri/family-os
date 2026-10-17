import type { Mention } from '@famos/sdk';
import { resolveMentions, SHARE_AI, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recurrenceOf } from '../src/server/understand.ts';
import { createKernel, type Person, person } from './support.ts';

let k: TestKernel;
let admin: Person;
let ivy: Person;
let leo: Person;
let bins: { id: string };

const of = (kind: string) => (m: Omit<Mention, 'kind'>) => ({ kind, ...m });
const chore = of('chores.chore');
const done = of('chores.done');
const turns = of('chores.turns');

async function add(input: Record<string, unknown>) {
	const r = await k.runner.invoke<{ id: string }>(
		'chores.createChore',
		{ startDate: '2026-10-06', ...input },
		admin.actor,
	);
	if (r.status !== 'applied') throw new Error('expected applied');
	return r.output;
}

beforeEach(async () => {
	({ k } = await createKernel());
	admin = await person(k, 'admin', 'Mara');
	ivy = await person(k, 'member', 'Ivy');
	leo = await person(k, 'member', 'Leo');
	bins = await add({
		title: 'Take out the bins',
		recurrence: { freq: 'weekly', byDay: ['TU'] },
		assigneeIds: [ivy.id, leo.id],
		rotation: 'round_robin',
	});
});
afterEach(() => k.close());

describe('a new chore', () => {
	it('lets the people named take turns, from the day the message says', async () => {
		const [out] = await resolveMentions(
			k,
			'chores.chore',
			[
				chore({
					title: 'Empty the dishwasher',
					people: ['Ivy', 'Leo'],
					date: { text: 'tomorrow', inDays: 1 },
					repeat: { every: 'day' },
				}),
			],
			{ text: 'From tomorrow Ivy and Leo take turns emptying the dishwasher, every day' },
		);
		expect(out).toEqual({
			propose: {
				actionId: 'chores.createChore',
				input: {
					title: 'Empty the dishwasher',
					startDate: '2026-10-07',
					recurrence: { freq: 'daily', interval: 1 },
					assigneeIds: [ivy.id, leo.id],
					rotation: 'round_robin',
				},
				subject: 'Empty the dishwasher',
				from: [0],
			},
		});
		if (!out || !('propose' in out)) throw new Error('expected a suggestion');
		expect((await k.runner.invoke(out.propose.actionId, out.propose.input, SHARE_AI)).status).toBe(
			'drafted',
		);
	});

	it('leaves anyone free when nobody is named, and marks people it guessed', async () => {
		const out = await resolveMentions(
			k,
			'chores.chore',
			[
				chore({ title: 'Water the plants', repeat: { every: 'week', weekdays: [6] } }),
				chore({ title: 'Feed the fish', people: ['Ivy'], peopleGuessed: true }),
				chore({ title: 'take out the bins' }),
			],
			{ text: 'Plants every Saturday; the fish need feeding; and the bins' },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'chores.createChore',
					input: {
						title: 'Water the plants',
						startDate: '2026-10-06',
						recurrence: { freq: 'weekly', interval: 1, byDay: ['SA'] },
						assigneeIds: [],
						rotation: 'fixed',
					},
					subject: 'Water the plants',
					from: [0],
				},
			},
			{
				propose: {
					actionId: 'chores.createChore',
					input: {
						title: 'Feed the fish',
						startDate: '2026-10-06',
						assigneeIds: [ivy.id],
						rotation: 'fixed',
					},
					subject: 'Feed the fish',
					uncertain: ['assigneeIds'],
					from: [1],
				},
			},
			{ refuse: { reason: 'already', subject: 'take out the bins', from: [2] } },
		]);
	});

	it('reads a repeat a chore can keep', () => {
		expect(recurrenceOf({ every: 'week', interval: 2 }, '2026-10-08', undefined)).toEqual({
			freq: 'weekly',
			interval: 2,
			byDay: ['TH'],
		});
		expect(recurrenceOf({ every: 'year' }, '2026-10-08', '2028-01-01')).toEqual({
			freq: 'monthly',
			interval: 12,
			until: '2028-01-01',
		});
		expect(recurrenceOf({ every: 'year', interval: 2 }, '2026-10-08', undefined)).toBeNull();
	});
});

describe('a listed chore', () => {
	it('marks it done for its due date by the person who did it', async () => {
		const out = await resolveMentions(
			k,
			'chores.done',
			[
				done({ target: 'bins', people: ['Leo'] }),
				done({ target: 'Take out the bins', forMe: true }),
				done({ target: 'Mow the lawn' }),
			],
			{ text: 'Leo took the bins out. I took out the bins too. Lawn mowed', sharer: admin.id },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'chores.markDone',
					input: { id: bins.id, dueDate: '2026-10-06', label: 'bins', doneBy: leo.id },
					subject: 'bins',
					targetTitle: 'Take out the bins',
					from: [0],
				},
			},
			{
				propose: {
					actionId: 'chores.markDone',
					input: {
						id: bins.id,
						dueDate: '2026-10-06',
						label: 'Take out the bins',
						doneBy: admin.id,
					},
					subject: 'Take out the bins',
					targetTitle: 'Take out the bins',
					from: [1],
				},
			},
			{ refuse: { reason: 'unknown', subject: 'Mow the lawn', from: [2] } },
		]);
	});

	it('says a one-off chore that is done is already done', async () => {
		const once = await add({ title: 'Clean the garage' });
		await k.runner.invoke('chores.markDone', { id: once.id, dueDate: '2026-10-06' }, admin.actor);
		const [out] = await resolveMentions(k, 'chores.done', [done({ target: 'Clean the garage' })], {
			text: 'Cleaned the garage',
		});
		expect(out).toEqual({ refuse: { reason: 'already', subject: 'Clean the garage', from: [0] } });
	});

	it('changes who takes turns only to people the message names', async () => {
		const out = await resolveMentions(
			k,
			'chores.turns',
			[
				turns({ target: 'Take out the bins', people: ['Leo', 'Ivy'] }),
				turns({ target: 'Take out the bins', people: ['Ivy', 'Leo'] }),
				turns({ target: 'Take out the bins' }),
			],
			{ text: 'From now on Leo and Ivy do the bins, Leo first' },
		);
		expect(out).toEqual([
			{
				propose: {
					actionId: 'chores.setAssignees',
					input: { id: bins.id, memberIds: [leo.id, ivy.id], choreTitle: 'Take out the bins' },
					subject: 'Take out the bins',
					targetTitle: 'Take out the bins',
					from: [0],
				},
			},
			{ refuse: { reason: 'already', subject: 'Take out the bins', from: [1] } },
			{ refuse: { reason: 'incomplete', subject: 'Take out the bins', from: [2] } },
		]);
	});
});
