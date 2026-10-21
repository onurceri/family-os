import calendar from '@famos/ext-calendar/server';
import kitchen from '@famos/ext-kitchen/server';
import lists from '@famos/ext-lists/server';
import { LlmError, systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnswerCard, Message } from '../src/contract/index.ts';
import assistant from '../src/server/index.ts';
import { loopTurns } from './reading.ts';

// Sunday 18 October 2026 in Ljubljana; the region's week starts on Monday.
const TZ = 'Europe/Ljubljana';
type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let mara: Asker;
let leo: Asker;

const THIS_WEEK = {
	intent: 'ask',
	topics: ['calendar'],
	span: { said: 'this week', kind: 'week', day: { text: 'this week', week: 'this' } },
	people: [],
};

beforeEach(async () => {
	k = await createTestKernel({
		extensions: [calendar, lists, kitchen, assistant],
		translate: repoTranslate(),
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, locale: 'en', formatLocale: 'sl-SI', weekStart: 1, hourCycle: 'h23' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-18', '10:00', TZ));
	mara = await k.member('admin', 'Mara');
	leo = await k.member('supervised', 'Leo');
	await k.runner.invoke(
		'core.updateMember',
		{ memberId: leo.member.id, about: '6 years old' },
		systemActor('test'),
	);
	const event = (input: Record<string, unknown>) =>
		k.runner.invoke('calendar.createEvent', input, systemActor('test'));
	await event({
		title: 'Swimming lesson',
		date: '2026-10-22',
		startTime: '16:30',
		endTime: '17:30',
		memberIds: [leo.member.id],
		notes: 'Pick up from the pool at 17:30',
	});
	await event({ title: "Dinner at Nona Marija's", date: '2026-10-23', startTime: '18:30' });
	await event({ title: 'Date night', date: '2026-10-31', startTime: '19:00' });
});
afterEach(() => k.close());

async function ask(who: Asker, text: string, threadId?: string) {
	const sent = await k.runner.invoke<{ threadId: string; replyId: string }>(
		'assistant.sendMessage',
		{ text, ...(threadId && { threadId }) },
		who.actor,
	);
	if (sent.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	const detail = (await k
		.route('assistant.getThread')
		.call({ params: { threadId: sent.output.threadId }, actor: who.actor })) as {
		messages: Message[];
	};
	const reply = detail.messages.find((m) => m.id === sent.output.replyId);
	if (!reply) throw new Error('expected the answer');
	// The next message comes a minute later.
	k.clock.advance(60_000);
	return { reply, threadId: sent.output.threadId, replyId: sent.output.replyId };
}

const cardOf = (reply: Message): AnswerCard => {
	if (!reply.card) throw new Error('expected an answer card');
	return reply.card;
};

describe('a question', () => {
	it('is answered from the digest: "this week" on a Sunday is the coming week', async () => {
		k.llm.respond(THIS_WEEK);
		k.llm.respondChat([{ text: 'Leo has a Swimming lesson on Thursday 22 October.' }]);
		const { reply } = await ask(mara, 'What is on this week?');
		const card = cardOf(reply);
		expect(reply.status).toBe('done');
		expect(card.understood.span).toEqual({
			key: 'coming_days',
			from: '2026-10-18',
			to: '2026-10-24',
		});
		expect(card.sections.map((s) => s.topic)).toEqual(['calendar']);
		expect(card.sections[0]?.items.map((i) => i.title)).toEqual([
			'Swimming lesson',
			"Dinner at Nona Marija's",
		]);
		expect(card.text).toEqual([
			'Calendar · The coming 7 days, Sun, 18 Oct – Sat, 24 Oct',
			'',
			'Calendar',
			'- Thursday, 22 October, 16:30–17:30: Swimming lesson (Leo) — Pick up from the pool at 17:30',
			"- Friday, 23 October, 18:30–19:30: Dinner at Nona Marija's",
		]);
		expect(reply.content).toBe('Leo has a Swimming lesson on Thursday 22 October.');
		expect(card.lead).toEqual({ kept: true, check: null });
		// The model chose nothing to read: code read the digest, as the AI working for Mara.
		expect(reply.toolCalls).toEqual([{ name: 'calendar.digest', ok: true }]);
		// The wording call has no tools and reads the card's facts.
		const wording = k.llm.chatCalls[0];
		expect(wording?.tools).toEqual([]);
		expect(String(wording?.messages[0]?.content)).toContain('Swimming lesson (Leo)');
		// The card's rows open their events; the wording call never sees a path or an id.
		expect(card.sections[0]?.items.map((i) => i.href)).toEqual([
			expect.stringMatching(/^\/calendar\?event=cal_event_[0-9a-f-]+&on=2026-10-22$/),
			expect.stringMatching(/^\/calendar\?event=cal_event_[0-9a-f-]+&on=2026-10-23$/),
		]);
		expect(String(wording?.messages[0]?.content)).not.toMatch(/\/calendar|cal_event|href/);
		// The reading saw the message, never the family's data.
		expect(k.llm.calls[0]?.areas).toEqual(['assistant']);
	});

	it('says nothing is on and what comes next, whatever the model writes (real model mix-up)', async () => {
		// Wednesday: the weekend is still to come, and holds nothing.
		k.clock.set(epochOf('2026-10-21', '10:00', TZ));
		k.llm.respond({
			intent: 'ask',
			topics: ['calendar'],
			span: { said: 'this weekend', kind: 'weekend' },
			people: [],
		});
		k.llm.respondChat([
			{ text: 'Nothing is planned this weekend; Date night is on Saturday 31 October.' },
		]);
		const { reply } = await ask(mara, "What's on this weekend?");
		expect(cardOf(reply).text.slice(2)).toEqual([
			'Calendar',
			'Nothing this weekend; next: Saturday, 31 October, 19:00–20:00: Date night.',
		]);
		expect(reply.content).toBe(
			'Nothing is planned this weekend; Date night is on Saturday 31 October.',
		);
	});

	it('drops opening words that write an ISO date, and records why', async () => {
		k.llm.respond(THIS_WEEK);
		// As a free model answered Leo: "due on Tuesday 2026-10-20".
		k.llm.respondChat([{ text: 'You have a Swimming lesson on 2026-10-22.' }]);
		const { reply } = await ask(mara, 'What is on this week?');
		expect(reply.content).toBe('');
		expect(cardOf(reply).lead).toEqual({ kept: false, check: 'iso_date' });
		expect(reply.status).toBe('done');
	});

	it('drops opening words that say "nothing" over a topic with things (real model answer)', async () => {
		k.llm.respond(THIS_WEEK);
		// Mara's round-5 answer: "no family events" while the week held five.
		k.llm.respondChat([{ text: 'There are no family events this week.' }]);
		const { reply } = await ask(mara, 'What is on for the family this week?');
		expect(cardOf(reply).lead.check).toBe('nothing_over_items');
	});

	it('drops opening words that run through every fact (real model answer)', async () => {
		k.llm.respond(THIS_WEEK);
		// nemotron-120b to Mara in the live check, cut down to this household's two events.
		k.llm.respondChat([
			{
				text: "On Thursday, 22 October Leo has a Swimming lesson from 16:30–17:30 with pick up from the pool at 17:30 and on Friday, 23 October the family has Dinner at Nona Marija's from 18:30–19:30, and on Thursday, 22 October Leo has a Swimming lesson from 16:30–17:30 with pick up from the pool at 17:30, and nothing else.",
			},
		]);
		const { reply } = await ask(mara, 'What is on for the family this week?');
		expect(cardOf(reply).lead).toEqual({ kept: false, check: 'too_long' });
	});

	it('drops opening words with a wrong weekday or a thing the facts do not hold', async () => {
		k.llm.respond(THIS_WEEK, THIS_WEEK);
		k.llm.respondChat(
			[{ text: 'Leo swims on Wednesday 22 October.' }],
			[{ text: 'Leo has a Dentist appointment and swimming.' }],
		);
		const first = await ask(mara, 'What is on this week?');
		expect(cardOf(first.reply).lead.check).toBe('wrong_weekday');
		const second = await ask(mara, 'What is on this week?', first.threadId);
		expect(cardOf(second.reply).lead.check).toBe('unknown_title');
	});

	it('points out a weekday the person wrote next to a date of another weekday', async () => {
		k.llm.respond({
			intent: 'ask',
			topics: ['calendar'],
			span: {
				said: 'on Wednesday 22 October',
				kind: 'day',
				day: { text: 'Wednesday 22 October', day: 22, month: 10, weekday: 3 },
			},
			people: [],
		});
		k.llm.respondChat([{ text: 'Leo has a Swimming lesson then.' }]);
		const { reply } = await ask(mara, 'Is there swimming on Wednesday 22 October?');
		const card = cardOf(reply);
		expect(card.text[1]).toBe('Thursday, 22 October is not a Wednesday.');
		expect(card.understood.mismatches).toEqual([{ date: '2026-10-22', said: 3 }]);
		expect(card.sections[0]?.items.map((i) => i.title)).toEqual(['Swimming lesson']);
	});

	it('reads "we" as the family, and someone named with it as that person (real model answer)', async () => {
		k.llm.respond(
			{ ...THIS_WEEK, people: [{ said: 'we' }, { said: 'Leo' }] },
			{ ...THIS_WEEK, people: [{ said: 'we' }] },
		);
		k.llm.respondChat([{ text: 'Leo swims.' }], [{ text: 'A quiet week.' }]);
		const first = await ask(mara, 'Do we need to pick Leo up anywhere this week?');
		expect(cardOf(first.reply).understood).toMatchObject({
			people: ['Leo'],
			everyone: false,
			unmatched: [],
		});
		const second = await ask(mara, 'What do we have this week?');
		expect(cardOf(second.reply).understood).toMatchObject({ everyone: true, unmatched: [] });
	});

	it('gives a child one sentence at most', async () => {
		k.llm.respond({ ...THIS_WEEK, people: [{ said: 'I' }] });
		k.llm.respondChat([
			{ text: 'You have a Swimming lesson on Thursday. It is fun. Bring goggles.' },
		]);
		const { reply } = await ask(leo, 'what do I have this week?');
		expect(reply.content).toBe('You have a Swimming lesson on Thursday.');
		expect(k.llm.chatCalls[0]?.system).toContain(
			'at most 1 sentence of at most 15 words in English',
		);
		expect(k.llm.chatCalls[0]?.system).toContain('"6 years old"');
		expect(cardOf(reply).understood.people).toEqual(['Leo']);
	});

	it('says how many more the days hold for others when the question is about someone', async () => {
		await k.runner.invoke(
			'calendar.createEvent',
			{
				title: 'Staff meeting',
				date: '2026-10-22',
				startTime: '09:00',
				memberIds: [mara.member.id],
			},
			systemActor('test'),
		);
		k.llm.respond({ ...THIS_WEEK, people: [{ said: 'I' }] }, THIS_WEEK);
		k.llm.respondChat([{ text: 'You have a Swimming lesson on Thursday.' }], [{ text: 'A week.' }]);
		const mine = cardOf((await ask(leo, 'what do I have this week?')).reply);
		// Leo's own lesson and the family's dinner are his; Mara's meeting is only counted.
		expect(mine.sections[0]?.items.map((i) => i.title)).toEqual([
			'Swimming lesson',
			"Dinner at Nona Marija's",
		]);
		expect(mine.sections[0]?.others).toEqual({ count: 1, more: false });
		expect(mine.text).toContain('One more is for someone else.');
		expect(mine.text.join('\n')).not.toContain('Staff meeting');
		// Nobody named: everything is shown, and there is no such line.
		const all = cardOf((await ask(mara, 'What is on this week?')).reply);
		expect(all.sections[0]?.items.map((i) => i.title)).toContain('Staff meeting');
		expect(all.sections[0]?.others).toBeUndefined();
	});

	it('reads the calendar beside the meal plan, so a dinner elsewhere is shown', async () => {
		k.llm.respond({
			intent: 'ask',
			topics: ['meals'],
			span: { said: 'on friday', kind: 'day', day: { text: 'friday', weekday: 5 } },
			people: [],
		});
		k.llm.respondChat([{ text: "Dinner is at Nona Marija's on Friday." }]);
		const { reply } = await ask(mara, 'what is for dinner on friday?');
		const card = cardOf(reply);
		expect(card.sections.map((s) => [s.topic, s.items.map((i) => i.title)])).toEqual([
			['meals', []],
			['calendar', ["Dinner at Nona Marija's"]],
		]);
		expect(reply.content).toBe("Dinner is at Nona Marija's on Friday.");
	});

	it('says which topics are not here, and why', async () => {
		const role = await k.runner.invoke<{ id: string }>(
			'core.createRole',
			{ name: 'No calendar', base: 'member', overrides: { 'calendar.view': false } },
			mara.actor,
		);
		if (role.status !== 'applied') throw new Error('expected the role');
		const limited = await k.member(role.output.id, 'Guest');
		k.llm.respond({ ...THIS_WEEK, topics: ['calendar', 'pets'] });
		k.llm.respondChat([{ text: 'I cannot see that here.' }]);
		const { reply } = await ask(limited, 'What is on this week, and the pets?');
		const card = cardOf(reply);
		expect(card.sections).toEqual([]);
		expect(card.notHere).toEqual([
			{ topic: 'pets', why: 'not_installed' },
			{ topic: 'calendar', why: 'not_allowed' },
		]);
		expect(card.text.slice(-2)).toEqual([
			'Pets: not installed here.',
			'Calendar: not something you can see.',
		]);
	});

	it('names an area closed to the AI', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'calendar', access: 'off' },
			mara.actor,
		);
		k.llm.respond(THIS_WEEK);
		k.llm.respondChat([{ text: 'Nothing here.' }]);
		const { reply } = await ask(mara, 'What is on this week?');
		expect(cardOf(reply).notHere).toEqual([{ topic: 'calendar', why: 'closed_to_ai' }]);
	});

	it('falls back to the events and tasks of the days when no topic is named', async () => {
		k.llm.respond({ ...THIS_WEEK, topics: [] });
		k.llm.respondChat([{ text: 'A quiet week.' }]);
		const { reply } = await ask(mara, 'Anything this week?');
		const card = cardOf(reply);
		expect(card.understood.fallback).toBe(true);
		expect(card.sections.map((s) => s.topic)).toEqual(['calendar', 'tasks']);
	});

	it('keeps the card when the wording call fails', async () => {
		k.llm.respond(THIS_WEEK);
		k.llm.respondChat(new LlmError('timeout', 'slow'));
		const { reply } = await ask(mara, 'What is on this week?');
		expect(reply.status).toBe('done');
		expect(reply.content).toBe('');
		expect(cardOf(reply).lead).toEqual({ kept: false, check: 'failed' });
	});

	it('lets a follow-up change point at what the card showed', async () => {
		k.llm.respond(THIS_WEEK);
		k.llm.respondChat([{ text: 'Leo has a Swimming lesson on Thursday.' }]);
		const first = await ask(mara, 'What is on this week?');
		loopTurns(k.llm, [{ text: 'Which time?' }]);
		await ask(mara, 'Move the swimming lesson', first.threadId);
		const loop = k.llm.chatCalls.at(-1);
		expect(loop?.system).toContain(': Swimming lesson');
		// The model's history holds the card as plain lines.
		expect(loop?.messages.map((m) => m.content).join('\n')).toContain('Swimming lesson (Leo)');
	});
});

describe('a message that is not a question', () => {
	it('goes to the tool loop', async () => {
		loopTurns(k.llm, [{ text: 'Done looking.' }]);
		const { reply } = await ask(mara, 'Add milk to the list');
		expect(reply.card).toBeNull();
		expect(reply.content).toBe('Done looking.');
	});

	it.each([
		['invalid_output', 'a broken answer'],
		['timeout', 'a slow provider (real model: nemotron-120b, twice past 60 s)'],
	] as const)(
		'goes to the tool loop when the reading could not be had: %s, %s',
		async (code, _why) => {
			// Asked again after the first failure, as the queue does; then the loop answers.
			const broken = () => new LlmError(code, 'no reading');
			k.llm.respond(broken(), broken());
			k.llm.respondChat([{ text: 'Here is what I found.' }]);
			const sent = await k.runner.invoke<{ threadId: string; replyId: string }>(
				'assistant.sendMessage',
				{ text: 'What is on this week?' },
				mara.actor,
			);
			if (sent.status !== 'applied') throw new Error('expected the message');
			await k.worker.drain();
			k.clock.advance(60_000);
			await k.worker.drain();
			const detail = (await k
				.route('assistant.getThread')
				.call({ params: { threadId: sent.output.threadId }, actor: mara.actor })) as {
				messages: Message[];
			};
			const reply = detail.messages.find((m) => m.id === sent.output.replyId);
			expect(reply?.card).toBeNull();
			expect(reply?.content).toBe('Here is what I found.');
		},
	);

	it('fails the turn when no model is set', async () => {
		k.llm.respond(new LlmError('not_configured', 'no model'));
		const { reply } = await ask(mara, 'What is on this week?');
		expect(reply.status).toBe('failed');
		expect(reply.errorCode).toBe('not_configured');
		expect(k.llm.chatCalls).toHaveLength(0);
	});
});

describe('a pronoun in a question', () => {
	const LEO_WEEK = {
		quote: 'What is Leo doing this week',
		...THIS_WEEK,
		people: [{ said: 'Leo' }],
	};
	const HIS = {
		quote: 'is anything of his still open?',
		intent: 'ask',
		topics: ['tasks'],
		people: [],
		span: THIS_WEEK.span,
	};

	it('stands for the person of the part before it, and is never an unknown name (real model reading)', async () => {
		k.llm.respond({ parts: [LEO_WEEK, { ...HIS, people: [{ said: 'his' }] }] });
		k.llm.respondChat([{ text: 'Leo has swimming.' }]);
		k.llm.respondChat([{ text: 'Nothing open.' }]);
		const { reply } = await ask(
			mara,
			'What is Leo doing this week, and is anything of his still open?',
		);
		expect(reply.cards).toHaveLength(2);
		const [first, second] = reply.cards;
		expect(first?.understood.people).toEqual(['Leo']);
		expect(second?.understood.people).toEqual(['Leo']);
		expect(second?.understood.unmatched).toEqual([]);
		expect(JSON.stringify(reply.cards)).not.toMatch(/called his/);
	});

	it('takes the previous question of the thread when no part comes before it', async () => {
		k.llm.respond({ parts: [LEO_WEEK] });
		k.llm.respondChat([{ text: 'Leo has swimming.' }]);
		const first = await ask(mara, 'What is Leo doing this week?');
		k.llm.respond({ parts: [{ ...HIS, people: [{ said: 'his' }] }] });
		k.llm.respondChat([{ text: 'Nothing open.' }]);
		const { reply } = await ask(mara, 'Is anything of his still open?', first.threadId);
		expect(cardOf(reply).understood.people).toEqual(['Leo']);
		expect(cardOf(reply).understood.unmatched).toEqual([]);
	});

	it('alone, with nobody before it, is dropped quietly', async () => {
		k.llm.respond({ parts: [{ ...HIS, people: [{ said: 'his' }] }] });
		k.llm.respondChat([{ text: 'Nothing open.' }]);
		const { reply } = await ask(mara, 'Is anything of his still open?');
		expect(cardOf(reply).understood.people).toEqual([]);
		expect(cardOf(reply).understood.unmatched).toEqual([]);
		expect(cardOf(reply).text.join('\n')).not.toMatch(/called/);
	});
});

describe('a question from a chat outside the app', () => {
	it('gets the opening words and the card as plain lines, in one sentence', async () => {
		k.llm.respond(THIS_WEEK);
		k.llm.respondChat([{ text: 'Leo has a Swimming lesson. Dinner is at Nona Marija’s.' }]);
		const asked = await k.conversation.ask(mara.member.id, {
			text: 'What is on this week?',
			threadId: null,
		});
		await k.worker.drain();
		const answer = await k.conversation.answer(mara.member.id, asked.replyId);
		expect(answer?.text).toMatch(
			/^Leo has a Swimming lesson\.\n\nCalendar · The coming 7 days[^\n]*\n\nCalendar\n- Thursday/,
		);
		expect(k.llm.chatCalls[0]?.system).toContain('at most 1 sentence');
	});
});
