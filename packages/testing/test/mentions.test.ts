import { defineAction, defineCapability, defineMentionKind } from '@famos/sdk';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
	createTestKernel,
	defineTestExtension,
	mention,
	resolveMentions,
	SHARE_AI,
	type TestKernel,
	understood,
} from '../src/index.ts';

// A reminder kind whose resolver reads the day and the people, as an extension's would.
const remindersEdit = defineCapability({
	id: 'reminders.edit',
	label: 'reminders:cap',
	level: 'edit',
});
const addReminder = defineAction({
	id: 'reminders.addReminder',
	title: 'Add a reminder',
	input: z.object({ title: z.string().min(1), date: z.string(), memberIds: z.array(z.string()) }),
	output: z.object({}),
	approval: { unless: remindersEdit.id },
	ai: { description: 'Adds a reminder.' },
	async run() {
		return {};
	},
});
const reminder = defineMentionKind({
	id: 'reminders.reminder',
	describe: 'Something to be reminded of on a day.',
	slots: { title: 'What to remember', date: 'The day', people: 'Who to remind' },
	actions: ['reminders.addReminder'],
	examples: [
		{
			text: 'Remind me to water the plants on Friday',
			mentions: [
				{
					kind: 'reminders.reminder',
					title: 'Water the plants',
					forMe: true,
					date: { text: 'Friday', weekday: 5 },
				},
			],
		},
	],
	async resolve(ctx, mentions) {
		return mentions.map(({ index, mention }) => {
			const day = ctx.day(mention.date);
			const people = ctx.people(mention);
			if (!mention.title || !day)
				return { refuse: { reason: 'incomplete', subject: mention.title ?? null, from: [index] } };
			return {
				propose: {
					actionId: 'reminders.addReminder',
					input: { title: mention.title, date: day.date, memberIds: people.ids },
					subject: mention.title,
					uncertain: [...(day.certain ? [] : ['date']), ...(people.certain ? [] : ['memberIds'])],
					from: [index],
				},
			};
		});
	},
});

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({
		extensions: [
			defineTestExtension({
				id: 'reminders',
				capabilities: [remindersEdit],
				actions: [addReminder],
				ai: { kinds: [reminder] },
			}),
		],
	});
});
afterEach(() => k.close());

it('resolves mentions as the AI and checks days against the words of the installed languages', async () => {
	const { member } = await k.member('admin', 'Mara');
	// 2026-01-01 is a Thursday; the model says Thursday where the words say Friday.
	const out = await resolveMentions(
		k,
		'reminders.reminder',
		[
			{
				kind: 'reminders.reminder',
				title: 'Water the plants',
				forMe: true,
				date: { text: 'Friday', weekday: 4 },
			},
			{ kind: 'reminders.reminder', date: { text: 'tomorrow', inDays: 1 } },
		],
		{ text: 'Remind me to water the plants on Friday', sharer: member.id },
	);
	expect(out).toEqual([
		{
			propose: {
				actionId: 'reminders.addReminder',
				input: { title: 'Water the plants', date: '2026-01-02', memberIds: [member.id] },
				subject: 'Water the plants',
				uncertain: ['date'],
				from: [0],
			},
		},
		{ refuse: { reason: 'incomplete', subject: null, from: [1] } },
	]);
	const [first] = out;
	if (!first || !('propose' in first)) throw new Error('expected a suggestion');
	const drafted = await k.ctx.actions.invoke(
		first.propose.actionId,
		first.propose.input,
		SHARE_AI,
		{
			draft: { uncertainFields: [...(first.propose.uncertain ?? [])] },
		},
	);
	expect(drafted.status).toBe('drafted');
});

it('writes a model answer of mentions for the fake model', () => {
	expect(understood()).toEqual({ label: 'Shared item', intent: 'nothing', mentions: [] });
	expect(
		understood([mention('reminders.reminder', { title: 'Water the plants' })], { label: 'Plants' }),
	).toEqual({
		label: 'Plants',
		intent: 'actionable',
		mentions: [{ kind: 'reminders.reminder', title: 'Water the plants' }],
	});
	expect(understood([], { intent: 'question' }).intent).toBe('question');
});
