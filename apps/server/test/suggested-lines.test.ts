import assistant from '@famos/ext-assistant/server';
import board from '@famos/ext-board/server';
import calendar from '@famos/ext-calendar/server';
import kitchen from '@famos/ext-kitchen/server';
import lists from '@famos/ext-lists/server';
import { type Actor, createHandleTable, type MemberId, runAgentTool } from '@famos/sdk';
import { createTestKernel, repoTranslate, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Every suggestion an agent makes is told back as one line that names the thing: the assistant
 * adds the line under its answer, an MCP client gets it as the `say` of the tool result. These
 * are the suggestions of a real MCP session whose lines were generic ("Changes an existing family
 * event: its time, date, place …") or missing.
 */
const TZ = 'Europe/Amsterdam';
type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let sofia: Who;
const translate = repoTranslate();

beforeEach(async () => {
	k = await createTestKernel({
		extensions: [calendar, lists, board, kitchen, assistant],
		translate,
	});
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: TZ, locale: 'en' },
		{ kind: 'system', source: 'test' },
	);
	k.clock.set(Date.parse('2026-10-12T19:45:00Z')); // 21:45 in Amsterdam
	sofia = await k.member('admin', 'Sofia');
	const made = (r: { status: string }) => {
		if (r.status !== 'applied') throw new Error(`expected applied, got ${r.status}`);
	};
	made(
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Delft project call', date: '2026-10-13', startTime: '09:30', endTime: '10:15' },
			sofia.actor,
		),
	);
	made(
		await k.runner.invoke(
			'lists.addShoppingItems',
			{ items: [{ title: 'Paracetamol' }] },
			sofia.actor,
		),
	);
});
afterEach(() => k.close());

/** The calls of the session, after a read of the calendar and the list gave the handles. */
const SUGGESTIONS: { tool: string; input: Record<string, unknown>; names: string }[] = [
	{
		tool: 'calendar.changeEvent',
		input: { id: 'cal_event:1', label: 'Delft project call', startTime: '14:00' },
		names: 'Delft project call',
	},
	{
		tool: 'lists.checkShoppingItem',
		input: { id: 'shop_item:1', label: 'paracetamol', done: true },
		names: 'Paracetamol',
	},
	{ tool: 'lists.addShoppingItems', input: { items: [{ title: 'Plasters' }] }, names: 'Plasters' },
	{
		tool: 'board.postNote',
		input: { text: "Ellie's choir jacket needs washing" },
		names: "Ellie's choir jacket needs washing",
	},
	{
		tool: 'lists.addTask',
		input: { title: 'Renew the BIG registration form', dueDate: '2026-10-16' },
		names: 'Renew the BIG registration form',
	},
	{
		tool: 'calendar.createEvent',
		input: { title: 'Board game night', date: '2026-10-15', startTime: '18:30', endTime: '20:00' },
		names: 'Board game night',
	},
];

const READS = [
	{ tool: 'calendar.findEvents', input: { from: '2026-10-13', to: '2026-10-13' } },
	{ tool: 'lists.shoppingList', input: {} },
];

const toolName = (id: string) => id.replace('.', '_');

describe('the line that names each suggestion', () => {
	async function answerTo(calls: typeof SUGGESTIONS, text: string) {
		k.llm.respondChat([
			...[...READS, ...calls].map((c) => ({ tool: toolName(c.tool), input: c.input })),
			{ text },
		]);
		const sent = await k.runner.invoke<{ threadId: string }>(
			'assistant.sendMessage',
			{ text: 'Move my Delft call to 14:00, tick off the paracetamol, and so on' },
			sofia.actor,
		);
		if (sent.status !== 'applied') throw new Error('expected the message to be stored');
		await k.worker.drain();
		const thread = await k
			.route('assistant.getThread')
			.call({ params: { threadId: sent.output.threadId }, actor: sofia.actor });
		return thread.messages.at(-1) as { status: string; content: string };
	}

	const linesOf = (content: string) => content.split('\n').filter((l) => l.startsWith('Suggested'));

	it('is one per suggestion under the assistant’s answer, naming the thing', async () => {
		const calls = SUGGESTIONS.slice(0, 4);
		const answer = await answerTo(calls, 'I suggested the changes.');
		expect(answer.content.startsWith('I suggested the changes.\n\n')).toBe(true);
		const lines = linesOf(answer.content);
		expect(lines).toHaveLength(calls.length);
		calls.forEach((s, i) => {
			expect(lines[i], s.tool).toMatch(/^Suggested, not added yet: .+: /);
			expect(lines[i], s.tool).toContain(s.names);
		});
	});

	it('names the suggestions even when the turn ran out of steps before an answer', async () => {
		// Eight tool calls use up the steps: the model never writes its answer.
		const answer = await answerTo(SUGGESTIONS, 'never reached');
		expect(answer.status).toBe('done');
		const lines = linesOf(answer.content);
		expect(lines).toHaveLength(SUGGESTIONS.length);
		SUGGESTIONS.forEach((s, i) => {
			expect(lines[i], s.tool).toMatch(/^Suggested, not added yet: .+: /);
			expect(lines[i], s.tool).toContain(s.names);
		});
	});

	it('is the say of each suggestion an MCP client makes, naming the thing', async () => {
		const actor: Actor = {
			kind: 'ai',
			mode: 'agent',
			source: 'mcp',
			sourceId: 'api_token_hermes',
			onBehalfOf: sofia.member.id as MemberId,
			roleId: 'admin',
		};
		const offered = new Map(
			k.ctx.actions.aiCatalog({ local: false, actor }).map((info) => [info.id, info]),
		);
		const table = createHandleTable();
		for (const read of READS)
			await runAgentTool({
				actions: k.ctx.actions,
				actor,
				table,
				actionId: read.tool,
				kind: 'read',
				input: read.input,
				draftTitle: read.tool,
			});
		for (const s of SUGGESTIONS) {
			const info = offered.get(s.tool);
			expect(info, s.tool).toBeDefined();
			// What the MCP server passes: the suggestion's name in the family language.
			const draftTitle = info?.draftTitle ? translate('en', info.draftTitle) : (info?.title ?? '');
			const outcome = await runAgentTool({
				actions: k.ctx.actions,
				actor,
				table,
				actionId: s.tool,
				kind: 'draft',
				input: s.input,
				draft: { sourceKind: 'mcp', sourceId: 'api_token_hermes' },
				draftTitle,
			});
			const say = (JSON.parse(outcome.text.split('\n').slice(1, -1).join('\n')) as { say: string })
				.say;
			expect(say, s.tool).toMatch(/^Suggested, not added yet: .+: /);
			expect(say, s.tool).toContain(s.names);
		}
	});
});
