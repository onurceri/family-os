import calendar from '@famos/ext-calendar/server';
import { systemActor } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import assistant from '../src/server/index.ts';
import { loopTurns } from './reading.ts';

/** The assistant finds things by meaning with `core.searchFamily`, only when set up. */
let k: TestKernel;
let ayse: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar, assistant] });
	await k.runner.invoke(
		'core.updateFamilySettings',
		{ timeZone: 'Europe/Istanbul' },
		systemActor('test'),
	);
	ayse = await k.member('admin', 'Ayşe');
});
afterEach(() => k.close());

async function ask(text: string) {
	const result = await k.runner.invoke<{ threadId: string }>(
		'assistant.sendMessage',
		{ text },
		ayse.actor,
	);
	if (result.status !== 'applied') throw new Error('expected the message to be stored');
	await k.worker.drain();
}
const tools = () => k.llm.chatCalls.at(-1)?.tools.map((t) => t.name) ?? [];

describe('search as a tool', () => {
	it('is not offered without an embedding model', async () => {
		loopTurns(k.llm, [{ text: 'Hello' }]);
		await ask('hi');
		expect(tools()).toContain('calendar_findEvents');
		expect(tools()).not.toContain('core_searchFamily');
	});

	it('is offered with one, finds an event by meaning and shows the model a handle, not an id', async () => {
		k.llm.embedModel = 'fake:embedder';
		await k.reconcileSearch();
		await k.worker.drain();
		await k.runner.invoke(
			'calendar.createEvent',
			{
				title: 'Boiler service visit',
				date: '2026-10-20',
				startTime: '10:00',
				notes: 'The plumber checks the warranty papers',
			},
			ayse.actor,
		);
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Piano lesson', date: '2026-10-21', startTime: '16:00' },
			ayse.actor,
		);
		await k.worker.drain();

		loopTurns(k.llm, [
			{ tool: 'core_searchFamily', input: { query: 'boiler warranty' } },
			{ text: 'There is a boiler service visit on 20 October.' },
		]);
		await ask('which paper is about the boiler warranty?');
		expect(tools()).toContain('core_searchFamily');
		const trace = k.llm.chatTrace.find((t) => t.tool === 'core_searchFamily');
		expect(trace?.ok).toBe(true);
		expect(trace?.result).toContain('Boiler service visit');
		expect(trace?.result).toMatch(/cal_event:\d/);
		expect(trace?.result).not.toMatch(/cal_event_[0-9a-f]{8}-/);
		expect(trace?.result).not.toContain('Piano lesson');
		// The model's request embedded the question once, for the asker.
		const queries = k.llm.embedCalls.filter((c) => c.feature === 'search');
		expect(queries).toHaveLength(1);
		expect(queries[0]).toMatchObject({ area: 'core', memberId: ayse.member.id });
	});

	it('does not search a local-only area for a model that is not local', async () => {
		k.llm.embedModel = 'fake:embedder';
		k.llm.privacy.local = true;
		await k.runner.invoke(
			'core.setAiAreaAccess',
			{ extensionId: 'calendar', access: 'local' },
			systemActor('test'),
		);
		await k.reconcileSearch();
		await k.worker.drain();
		await k.runner.invoke(
			'calendar.createEvent',
			{ title: 'Boiler service visit', date: '2026-10-20', startTime: '10:00' },
			ayse.actor,
		);
		await k.worker.drain();

		// The chat model is not local, the embedding model is: the area is indexed but closed to it.
		k.llm.privacy.local = false;
		loopTurns(k.llm, [{ tool: 'core_searchFamily', input: { query: 'boiler service' } }]);
		await ask('boiler?');
		expect(k.llm.chatTrace.find((t) => t.tool === 'core_searchFamily')?.result ?? '').not.toContain(
			'Boiler service visit',
		);
	});
});
