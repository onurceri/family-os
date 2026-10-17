import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import records from '@famos/ext-records/server';
import vehicles from '@famos/ext-vehicles/server';
import { type Actor, LlmError, systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message, ThreadDetail } from '../src/contract/index.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import assistant from '../src/server/index.ts';
import { KEEP_VERBATIM } from '../src/server/turn.ts';

type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let ayse: Asker;
let can: Asker;
let kid: Asker;
/** Private events by member: what the realtime hub would deliver to each. */
let delivered: Record<string, { name: string; payload: Record<string, unknown> }[]>;
let broadcast: string[];

beforeEach(async () => {
	k = await createTestKernel({
		extensions: [calendar, lists, records, vehicles, assistant],
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: 'Europe/Istanbul', locale: 'en' },
		systemActor('test'),
	);
	ayse = await k.member('admin', 'Ayşe');
	can = await k.member('member', 'Can');
	kid = await k.member('supervised', 'Elif');
	delivered = {};
	broadcast = [];
	k.bus.onMember((memberId, name, payload) => {
		const list = delivered[memberId] ?? [];
		list.push({ name, payload: payload as Record<string, unknown> });
		delivered[memberId] = list;
	});
	k.bus.onAny((name) => void broadcast.push(name));
});
afterEach(() => k.close());

async function ask(who: Asker, text: string, threadId?: string) {
	const result = await k.runner.invoke<{ threadId: string; messageId: string; replyId: string }>(
		'assistant.sendMessage',
		{ text, ...(threadId && { threadId }) },
		who.actor,
	);
	if (result.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	return result.output;
}
const thread = (who: Asker, threadId: string): Promise<ThreadDetail> =>
	k.route('assistant.getThread').call({ params: { threadId }, actor: who.actor });
const reply = async (who: Asker, sent: { threadId: string }): Promise<Message> =>
	(await thread(who, sent.threadId)).messages.at(-1) as Message;
const draftRows = () =>
	k.ctx.db
		.withTables<{
			core_drafts: {
				id: string;
				action_id: string;
				proposed_by: string;
				source_kind: string | null;
				status: string;
			};
		}>()
		.selectFrom('core_drafts')
		.selectAll()
		.execute();
const toolNames = () => k.llm.chatCalls.at(-1)?.tools.map((t) => t.name) ?? [];

describe('a turn', () => {
	it('answers from a read tool and streams only to the asker', async () => {
		await k.runner.invoke(
			'calendar.createEvent',
			{
				title: 'Dentist',
				date: '2026-01-02',
				startTime: '10:30',
				memberIds: [ayse.member.id],
			},
			ayse.actor,
		);
		k.llm.respondChat([
			{ tool: 'calendar_findEvents', input: { from: '2026-01-01', to: '2026-01-07' } },
			{ text: 'Friday 10:30 you have the dentist.' },
		]);
		const sent = await ask(ayse, "What's on the calendar this week?");

		expect(await reply(ayse, sent)).toMatchObject({
			role: 'assistant',
			status: 'done',
			content: 'Friday 10:30 you have the dentist.',
			toolCalls: [{ name: 'calendar.findEvents', ok: true }],
		});
		// The model saw the event as delimited data, with a handle for the member, never an id.
		const trace = k.llm.chatTrace[0];
		expect(trace?.result).toMatch(/^<tool_result name="calendar\.findEvents">/);
		expect(trace?.result).toContain('Dentist');
		expect(trace?.result).toContain('"time":"10:30-11:30"');
		expect(trace?.result).toContain('member:1');
		expect(trace?.result).not.toMatch(/member_[0-9a-f]{8}-/);
		// Model call details: its own feature, areas, the member's name and today's date.
		const call = k.llm.chatCalls[0];
		expect(call).toMatchObject({ feature: 'assistant.chat', role: 'smart', maxSteps: 8 });
		expect(call?.areas).toContain('calendar');
		expect(call?.system).toContain('Ayşe (member:1)');
		expect(call?.system).toContain('Thursday, 2026-01-01');
		expect(call?.messages).toEqual([
			{ role: 'user', content: "What's on the calendar this week?" },
		]);

		// Deltas went to Ayşe alone, in order, then done; nothing was broadcast.
		const mine = delivered[ayse.member.id] ?? [];
		expect(
			mine
				.filter((e) => e.name === 'assistant.delta')
				.map((e) => e.payload.text)
				.join(''),
		).toBe('Friday 10:30 you have the dentist.');
		expect(mine.slice(-2)).toMatchObject([
			{
				name: 'assistant.done',
				payload: { threadId: sent.threadId, messageId: sent.replyId, status: 'done' },
			},
			// Channels outside the app learn of the answer by its id alone.
			{ name: 'core.conversation.answered', payload: { replyId: sent.replyId } },
		]);
		expect(delivered[can.member.id]).toBeUndefined();
		expect(delivered[kid.member.id]).toBeUndefined();
		expect(broadcast.filter((n) => n.startsWith('assistant.'))).toEqual([]);
	});

	it('tells the model the date, the time and the rest of the week in the family time zone', async () => {
		// Saturday 2026-10-10, 23:30 in Istanbul is still Saturday 20:30 in UTC.
		k.clock.set(Date.parse('2026-10-10T20:30:00Z'));
		k.llm.respondChat([{ text: 'Sunday: nothing yet.' }]);
		await ask(ayse, 'What is on this week?');
		const system = k.llm.chatCalls.at(-1)?.system ?? '';
		expect(system).toContain(
			'Now it is Saturday, 2026-10-10, 23:30 in the family time zone Europe/Istanbul.',
		);
		expect(system).toContain('Still ahead this week: the rest of today, Sunday 2026-10-11.');
	});

	it('gives the model the days around the family’s today, also when UTC is still on the day before', async () => {
		// Tuesday 2026-10-13, 00:30 in Istanbul is still Monday 21:30 in UTC.
		k.clock.set(Date.parse('2026-10-12T21:30:00Z'));
		k.llm.respondChat([{ text: 'Tuesday 20 October.' }]);
		await ask(ayse, 'What is on Wednesday 20 October?');
		const system = k.llm.chatCalls.at(-1)?.system ?? '';
		expect(system).toContain(
			'Mon 2026-10-12 (yesterday)\nTue 2026-10-13 (today)\nWed 2026-10-14 (tomorrow)',
		);
		expect(system).toContain('Tue 2026-10-20\n');
		expect(system).toContain("when a person's weekday and date disagree, say so and ask");
	});

	it('keeps threads private to their member', async () => {
		k.llm.respondChat([{ text: 'Hello' }]);
		const sent = await ask(ayse, 'Hi');
		expect(
			(await k.route('assistant.listThreads').call({ actor: ayse.actor })).map(
				(t: { id: string }) => t.id,
			),
		).toEqual([sent.threadId]);
		expect(await k.route('assistant.listThreads').call({ actor: can.actor })).toEqual([]);
		await expect(thread(can, sent.threadId)).rejects.toMatchObject({ code: 'not_found' });
		// Nobody else can add to, rename or delete it; even an admin is "not found".
		for (const [id, input] of [
			['assistant.sendMessage', { threadId: sent.threadId, text: 'x' }],
			['assistant.renameThread', { id: sent.threadId, title: 'x' }],
			['assistant.deleteThread', { id: sent.threadId }],
		] as const)
			await expect(k.runner.invoke(id, input, can.actor)).rejects.toMatchObject({
				code: 'not_found',
			});
		// Not as the system either: the assistant is personal.
		await expect(
			k.runner.invoke('assistant.sendMessage', { text: 'x' }, systemActor('test')),
		).rejects.toMatchObject({ code: 'forbidden' });

		await k.runner.invoke(
			'assistant.renameThread',
			{ id: sent.threadId, title: 'Chat' },
			ayse.actor,
		);
		expect((await thread(ayse, sent.threadId)).thread.title).toBe('Chat');
		await k.runner.invoke('assistant.deleteThread', { id: sent.threadId }, ayse.actor);
		await expect(thread(ayse, sent.threadId)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('does not need the capability for guests', async () => {
		const guest = await k.member('guest', 'Visitor');
		await expect(
			k.runner.invoke('assistant.sendMessage', { text: 'hi' }, guest.actor),
		).rejects.toMatchObject({ code: 'forbidden' });
		expect(await k.llm.chatCalls).toHaveLength(0);
	});

	it('refuses a second question while the first is being answered', async () => {
		const first = await k.runner.invoke<{ threadId: string }>(
			'assistant.sendMessage',
			{ text: 'one' },
			ayse.actor,
		);
		if (first.status !== 'applied') throw new Error('expected applied');
		await expect(
			k.runner.invoke(
				'assistant.sendMessage',
				{ text: 'two', threadId: first.output.threadId },
				ayse.actor,
			),
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('creates a draft for a change, recorded with the member, and applies nothing', async () => {
		k.llm.respondChat([
			{ tool: 'lists_addShoppingItems', input: { items: [{ title: 'Milk' }] } },
			{ text: 'I suggested adding milk; someone needs to approve it.' },
		]);
		const sent = await ask(can, 'Add milk to the shopping list');
		const message = await reply(can, sent);
		expect(message.status).toBe('done');
		expect(message.toolCalls).toHaveLength(1);
		expect(message.toolCalls[0]).toMatchObject({ name: 'lists.addShoppingItems', ok: true });
		const draftId = message.toolCalls[0]?.draftId as string;

		const rows = await draftRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: draftId,
			action_id: 'lists.addShoppingItems',
			status: 'pending',
			source_kind: 'assistant',
		});
		expect(JSON.parse(rows[0]?.proposed_by ?? '')).toMatchObject({
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			onBehalfOf: can.member.id,
		});
		expect(k.llm.chatTrace[0]?.result).toContain('"status":"drafted"');
		expect(k.llm.chatTrace[0]?.result).toContain('"added":false');
		expect(k.llm.chatTrace[0]?.result).not.toContain(draftId);
		// Nothing is on the list until a person approves.
		const shopping = await k.runner.invoke<{ lists: { items: { title: string }[] }[] }>(
			'lists.shoppingList',
			{},
			ayse.actor,
		);
		expect(shopping.status === 'applied' && shopping.output.lists[0]?.items).toEqual([]);

		// It is addressed to the person it was suggested for: another approver does not
		// even learn it exists.
		await expect(k.runner.approveDraft(draftId, ayse.actor)).rejects.toMatchObject({
			code: 'not_found',
		});
		await k.runner.approveDraft(draftId, can.actor);
		const after = await k.runner.invoke<{ lists: { items: { title: string }[] }[] }>(
			'lists.shoppingList',
			{},
			ayse.actor,
		);
		expect(after.status === 'applied' && after.output.lists[0]?.items.map((i) => i.title)).toEqual([
			'Milk',
		]);
	});

	it('maps handles back to ids and refuses invented ones', async () => {
		k.llm.respondChat([
			{
				tool: 'lists_addTask',
				input: { title: 'Pay the fee', assigneeId: 'member:2' },
			},
			{
				tool: 'lists_addTask',
				input: { title: 'Bogus', assigneeId: 'member_01990000-0000-7000-8000-000000000000' },
			},
			{ text: 'ok' },
		]);
		const sent = await ask(ayse, 'Remind Can to pay the fee');
		const message = await reply(ayse, sent);
		expect(message.toolCalls.map((c) => c.ok)).toEqual([true, false]);
		const rows = await draftRows();
		expect(rows).toHaveLength(1);
		const input = (
			await k.ctx.db
				.withTables<{ core_drafts: { input: string } }>()
				.selectFrom('core_drafts')
				.select('input')
				.executeTakeFirstOrThrow()
		).input;
		expect(JSON.parse(input)).toMatchObject({ title: 'Pay the fee', assigneeId: can.member.id });
		expect(k.llm.chatTrace[1]?.result).toContain('Error (unknown)');
	});

	it('leaves out the tools of a local-only area for a model that is not local', async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'calendar', access: 'local' },
			ayse.actor,
		);
		k.llm.respondChat([{ text: 'a' }], [{ text: 'b' }]);
		await ask(ayse, 'What is on this week?');
		expect(toolNames().some((n) => n.startsWith('calendar_'))).toBe(false);
		expect(k.llm.chatCalls.at(-1)?.areas).not.toContain('calendar');
		// The same area is offered when the model runs on the family's own network.
		k.llm.privacy.local = true;
		await ask(ayse, 'And next week?');
		expect(toolNames()).toContain('calendar_findEvents');
		expect(k.llm.chatCalls.at(-1)?.areas).toContain('calendar');
	});

	it('fails with a clear code when the feature is turned off', async () => {
		k.llm.privacy.enabled = false;
		const sent = await ask(ayse, 'Hello?');
		expect(await reply(ayse, sent)).toMatchObject({
			role: 'assistant',
			status: 'failed',
			errorCode: 'disabled',
			content: '',
		});
		expect(k.llm.chatCalls).toHaveLength(0);
		expect(delivered[ayse.member.id]?.at(-2)).toMatchObject({
			name: 'assistant.done',
			payload: { status: 'failed' },
		});
	});

	it('records model errors by code, retrying only the ones that can pass', async () => {
		k.llm.respondChat(new LlmError('limit_reached', 'out of budget'));
		const limited = await ask(ayse, 'one');
		expect(await reply(ayse, limited)).toMatchObject({
			status: 'failed',
			errorCode: 'limit_reached',
		});

		// No provider of the model meets the data rules: failed at once, with a reason that names
		// the option.
		k.llm.respondChat(
			new LlmError(
				'data_policy',
				'No provider of this model meets the data rules: turn off "Only providers that keep no data" in AI privacy, choose another model, or check the privacy settings of the OpenRouter account',
			),
		);
		const blocked = await ask(ayse, 'one again');
		expect(await reply(ayse, blocked)).toMatchObject({
			status: 'failed',
			errorCode: 'data_policy',
		});
		expect(en.failed_data_policy).toContain('Only providers that keep no data');

		k.llm.respondChat(new LlmError('timeout', 'slow'), [{ text: 'second time lucky' }]);
		const sent = await ask(ayse, 'two');
		// The first attempt failed in a way that can pass: the answer is back to waiting.
		expect(await reply(ayse, sent)).toMatchObject({ status: 'pending', content: '' });
		k.clock.advance(10_000);
		await k.worker.drain();
		expect(await reply(ayse, sent)).toMatchObject({
			status: 'done',
			content: 'second time lucky',
		});
		// The retry told the browser to forget the text of the first attempt.
		expect(
			delivered[ayse.member.id]?.some(
				(e) => e.name === 'assistant.delta' && e.payload.reset === true,
			),
		).toBe(true);

		k.llm.respondChat(new LlmError('timeout', 'slow'), new LlmError('timeout', 'slow'));
		const hopeless = await ask(ayse, 'three');
		k.clock.advance(10_000);
		await k.worker.drain();
		expect(await reply(ayse, hopeless)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
	});

	it('keeps the last step for the answer when the model keeps calling tools', async () => {
		const calls = Array.from({ length: 10 }, (_, i) => ({
			tool: 'calendar_findEvents',
			input: { from: `2026-01-${String(i + 1).padStart(2, '0')}`, to: '2026-01-20' },
		}));
		k.llm.respondChat([...calls, { text: 'Nothing on those days.' }]);
		const sent = await ask(ayse, 'loop');
		const message = await reply(ayse, sent);
		expect(message).toMatchObject({ status: 'done', content: 'Nothing on those days.' });
		expect(k.llm.chatTrace).toHaveLength(7);
	});

	it('answers a repeated call from the turn and closes the tools when it keeps repeating', async () => {
		// gpt-4.1-mini sent the same lookup again and again until the step limit, with no answer.
		const same = { tool: 'calendar_findEvents', input: { from: '2026-01-01', to: '2026-01-02' } };
		k.llm.respondChat([same, same, same, same, same, { text: 'Nothing then.' }]);
		const sent = await ask(ayse, 'loop');
		const message = await reply(ayse, sent);
		expect(message).toMatchObject({ status: 'done', content: 'Nothing then.' });
		// Run once, answered twice from the turn, then no more tools.
		expect(k.llm.chatTrace).toHaveLength(3);
		expect(message.toolCalls).toHaveLength(1);
		expect(k.llm.chatTrace[1]?.result).toContain('already made in this turn');
		expect(k.llm.chatTrace[1]?.result).toContain(k.llm.chatTrace[0]?.result ?? '-');
	});

	it('fails with no_answer when the model ends without any words or suggestions', async () => {
		k.llm.respondChat([{ tool: 'calendar_findEvents', input: { from: '2026-01-01' } }]);
		const sent = await ask(ayse, 'quiet');
		expect(await reply(ayse, sent)).toMatchObject({ status: 'failed', errorCode: 'no_answer' });
	});

	it('does not answer a member who was archived meanwhile', async () => {
		const result = await k.runner.invoke<{ threadId: string }>(
			'assistant.sendMessage',
			{ text: 'hello' },
			can.actor,
		);
		if (result.status !== 'applied') throw new Error('expected applied');
		await k.runner.invoke('core.archiveMember', { memberId: can.member.id }, ayse.actor);
		await k.worker.drain();
		expect(k.llm.chatCalls).toHaveLength(0);
		const rows = await k.ctx.db
			.withTables<{ assistant_messages: { status: string; error_code: string | null } }>()
			.selectFrom('assistant_messages')
			.selectAll()
			.where('role' as never, '=', 'assistant' as never)
			.execute();
		expect(rows[0]).toMatchObject({ status: 'failed', error_code: 'forbidden' });
	});
});

describe('long threads', () => {
	it('sends the last messages verbatim plus a summary, and summarises in the background', async () => {
		const first = await k.runner.invoke<{ threadId: string }>(
			'assistant.sendMessage',
			{ text: 'start' },
			ayse.actor,
		);
		if (first.status !== 'applied') throw new Error('expected applied');
		const { threadId } = first.output;
		k.llm.respondChat([{ text: 'reply 0' }]);
		await k.worker.drain();
		// Many earlier turns (stored directly; each is a pair of messages).
		const db = k.ctx.db.withTables<{
			assistant_messages: {
				id: string;
				thread_id: string;
				role: string;
				content: string;
				tool_calls: string | null;
				status: string;
				error_code: string | null;
				created_at: number;
			};
		}>();
		const base = k.clock.now();
		await db
			.insertInto('assistant_messages')
			.values(
				Array.from({ length: 40 }, (_, i) => ({
					id: `asst_msg_01990000-0000-7000-8000-${String(i).padStart(12, '0')}`,
					thread_id: threadId,
					role: i % 2 === 0 ? 'user' : 'assistant',
					content: `older ${i}`,
					tool_calls: null,
					status: 'done',
					error_code: null,
					created_at: base - 1_000_000 + i,
				})),
			)
			.execute();
		k.llm.respondChat([{ text: 'reply 1' }]);
		// The summariser runs right after the turn (the test worker drains everything).
		k.llm.respond({ summary: 'They planned the week.' });
		const sent = await ask(ayse, 'what now?', threadId);
		const call = k.llm.chatCalls.at(-1);
		expect(call?.messages.length).toBeLessThanOrEqual(KEEP_VERBATIM);
		expect(call?.messages.at(-1)).toEqual({ role: 'user', content: 'what now?' });
		expect((await reply(ayse, sent)).content).toBe('reply 1');

		// The turn queued the summariser (more than 30 messages were not summarised yet).
		const row = await k.ctx.db
			.withTables<{ assistant_threads: { summary: string | null; summarized_count: number } }>()
			.selectFrom('assistant_threads')
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(row.summary).toBe('They planned the week.');
		expect(row.summarized_count).toBeGreaterThan(30);
		// The answer and the summary ask for the most likely words, so the same question gets the
		// same lookups and suggestions from one run to the next.
		expect(call?.temperature).toBe(0);
		expect(k.llm.calls.at(-1)?.temperature).toBe(0);
		// The summary reaches the next turn, as data.
		k.llm.respondChat([{ text: 'reply 2' }]);
		await ask(ayse, 'and then?', threadId);
		expect(k.llm.chatCalls.at(-1)?.system).toContain('They planned the week.');
	});
});

describe('actors', () => {
	it('the stored draft proposer is the AI acting for the asker', async () => {
		const actor: Actor = {
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			onBehalfOf: kid.member.id as never,
			roleId: 'supervised',
		};
		await expect(
			k.runner.invoke('lists.addShoppingItems', { items: [{ title: 'x' }] }, actor),
		).resolves.toMatchObject({ status: 'drafted' });
	});
});
