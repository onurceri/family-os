import calendar from '@famos/ext-calendar/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../src/contract/index.ts';
import assistant from '../src/server/index.ts';

// Sunday 18 October 2026 in Ljubljana.
const TZ = 'Europe/Ljubljana';
type Asker = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let mara: Asker;

const THIS_WEEK = {
	intent: 'ask',
	topics: ['calendar'],
	span: { said: 'this week', kind: 'week', day: { text: 'this week', week: 'this' } },
	people: [],
};
const CHAT = { intent: 'chat', topics: [], span: null, people: [] };

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar, assistant], translate: repoTranslate() });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, locale: 'en', formatLocale: 'sl-SI', weekStart: 1, hourCycle: 'h23' },
		systemActor('test'),
	);
	k.clock.set(epochOf('2026-10-18', '10:00', TZ));
	mara = await k.member('admin', 'Mara');
	const leopold = await k.member('supervised', 'Leopold');
	await k.runner.invoke(
		'calendar.createEvent',
		{
			title: 'Swimming lesson',
			date: '2026-10-22',
			startTime: '16:30',
			endTime: '17:30',
			memberIds: [leopold.member.id],
		},
		systemActor('test'),
	);
});
afterEach(() => k.close());

async function ask(text: string, threadId?: string) {
	const sent = await k.runner.invoke<{ threadId: string; replyId: string }>(
		'assistant.sendMessage',
		{ text, ...(threadId && { threadId }) },
		mara.actor,
	);
	if (sent.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
	const detail = (await k
		.route('assistant.getThread')
		.call({ params: { threadId: sent.output.threadId }, actor: mara.actor })) as {
		messages: Message[];
	};
	const reply = detail.messages.find((m) => m.id === sent.output.replyId);
	if (!reply) throw new Error('expected the answer');
	k.clock.advance(60_000);
	return { reply, threadId: sent.output.threadId };
}

/** Everything the model was asked in chat calls from `from` on. */
const chatsSince = (from: number) => JSON.stringify(k.llm.chatCalls.slice(from));

async function askThisWeek(lead = 'There is a swimming lesson on Thursday.') {
	k.llm.respond(THIS_WEEK);
	k.llm.respondChat([{ text: lead }]);
	return ask('What is on this week?');
}

async function followUp(threadId: string) {
	const from = k.llm.chatCalls.length;
	k.llm.respond(CHAT);
	k.llm.respondChat([{ text: 'You are welcome.' }]);
	const { reply } = await ask('Thanks!', threadId);
	expect(reply.status).toBe('done');
	return chatsSince(from);
}

type Rows = {
	assistant_threads: {
		id: string;
		summary: string | null;
		summarized_count: number;
		handles: string | null;
	};
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
};
const db = () => k.ctx.db.withTables<Rows>();

/** Earlier turns stored directly after what the thread holds, so it needs a summary. */
async function fillThread(threadId: string, count: number) {
	const base = k.clock.now();
	await db()
		.insertInto('assistant_messages')
		.values(
			Array.from({ length: count }, (_, i) => ({
				id: `asst_msg_01990000-0000-7000-8000-${String(i).padStart(12, '0')}`,
				thread_id: threadId,
				role: i % 2 === 0 ? 'user' : 'assistant',
				content: `later ${i}`,
				tool_calls: null,
				status: 'done',
				error_code: null,
				created_at: base + i,
			})),
		)
		.execute();
	k.clock.advance(60_000);
}

describe("people's details in later turns", () => {
	it('keeps names out of a follow-up when they are not sent, and shows them to the person', async () => {
		k.llm.privacy.sendPeople = false;
		const { reply, threadId } = await askThisWeek();
		expect(reply.card?.text.join('\n')).toContain('Leopold');
		expect(chatsSince(0)).not.toContain('Leopold');

		const asked = await followUp(threadId);
		expect(asked).not.toContain('Leopold');
		// The card's facts still reach the model, only without the people.
		expect(asked).toContain('Swimming lesson');
	});

	it('keeps names out once the switch is turned off in the middle of a thread', async () => {
		const { threadId } = await askThisWeek('Leopold has a swimming lesson on Thursday.');
		expect(chatsSince(0)).toContain('Leopold');

		k.llm.privacy.sendPeople = false;
		const asked = await followUp(threadId);
		expect(asked).not.toContain('Leopold');
		expect(asked).toContain('has a swimming lesson on Thursday.');
	});

	it('still sends names in a follow-up when the family shares them', async () => {
		const { threadId } = await askThisWeek();
		const asked = await followUp(threadId);
		expect(asked).toContain('Swimming lesson (Leopold)');
	});

	it('keeps names out of what the summariser reads', async () => {
		const { threadId } = await askThisWeek('Leopold has a swimming lesson on Thursday.');
		await fillThread(threadId, 40);
		k.llm.privacy.sendPeople = false;
		const objects = k.llm.calls.length;
		k.llm.respond(CHAT);
		k.llm.respondChat([{ text: 'Fine.' }]);
		k.llm.respond({ summary: 'They planned the week.' });
		await ask('What now?', threadId);
		const summarising = k.llm.calls.slice(objects).find((c) => c.prompt.includes('New messages'));
		expect(summarising?.prompt).toContain('Swimming lesson');
		expect(summarising?.prompt).not.toContain('Leopold');
	});

	it('keeps names out of a summary written while they were shared', async () => {
		const { threadId } = await askThisWeek();
		await db()
			.updateTable('assistant_threads')
			.set({ summary: "Leopold's swimming lesson is on Thursday.", summarized_count: 1 })
			.where('id', '=', threadId)
			.execute();
		k.llm.privacy.sendPeople = false;
		const from = k.llm.chatCalls.length;
		await followUp(threadId);
		const system = String(k.llm.chatCalls.at(from)?.system);
		expect(system).toContain("someone's swimming lesson is on Thursday.");
		expect(system).not.toContain('Leopold');
	});
});

describe('local-only areas in later turns', () => {
	beforeEach(async () => {
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'calendar', access: 'local' },
			mara.actor,
		);
		k.llm.privacy.local = true;
	});

	it('keeps an answer from a local-only area away from a model that is not local', async () => {
		const { reply, threadId } = await askThisWeek();
		expect(reply.card?.sections.map((s) => s.topic)).toEqual(['calendar']);

		k.llm.privacy.local = false;
		const asked = await followUp(threadId);
		expect(asked).not.toContain('Swimming lesson');
		expect(asked).not.toContain('swimming lesson');
		expect(k.llm.chatCalls.at(-1)?.areas).not.toContain('calendar');
	});

	it('leaves out a remembered record whose area is not known while an area is closed', async () => {
		const { threadId } = await askThisWeek();
		const thread = await db()
			.selectFrom('assistant_threads')
			.select('handles')
			.where('id', '=', threadId)
			.executeTakeFirstOrThrow();
		const handles = JSON.parse(thread.handles ?? '{}') as Record<string, { area?: string }>;
		expect(Object.values(handles).map((h) => h.area)).toContain('calendar');
		// Handles kept before their area was recorded.
		for (const handle of Object.values(handles)) delete handle.area;
		await db()
			.updateTable('assistant_threads')
			.set({ handles: JSON.stringify(handles) })
			.where('id', '=', threadId)
			.execute();
		k.llm.privacy.local = false;
		const asked = await followUp(threadId);
		expect(asked).not.toContain('Swimming lesson');
	});

	it('names the area of a replayed answer for a local model', async () => {
		const { threadId } = await askThisWeek();
		const asked = await followUp(threadId);
		expect(asked).toContain('Swimming lesson');
		expect(k.llm.chatCalls.at(-1)?.areas).toContain('calendar');
	});

	it('does not summarise a local-only answer for a model that is not local', async () => {
		const { threadId } = await askThisWeek();
		await fillThread(threadId, 40);
		k.llm.privacy.local = false;
		const objects = k.llm.calls.length;
		k.llm.respond(CHAT);
		k.llm.respondChat([{ text: 'Fine.' }]);
		await ask('What now?', threadId);
		const asked = JSON.stringify(k.llm.calls.slice(objects));
		expect(asked).not.toContain('New messages');
		const thread = await db()
			.selectFrom('assistant_threads')
			.selectAll()
			.where('id', '=', threadId)
			.executeTakeFirstOrThrow();
		expect(thread).toMatchObject({ summary: null, summarized_count: 0 });
	});

	it('leaves out a summary of a local-only answer for a model that is not local', async () => {
		const { threadId } = await askThisWeek();
		await db()
			.updateTable('assistant_threads')
			.set({ summary: 'A swimming lesson is on Thursday.', summarized_count: 2 })
			.where('id', '=', threadId)
			.execute();
		k.llm.privacy.local = false;
		const from = k.llm.chatCalls.length;
		await followUp(threadId);
		expect(String(k.llm.chatCalls.at(from)?.system)).not.toContain('swimming lesson');
	});
});
