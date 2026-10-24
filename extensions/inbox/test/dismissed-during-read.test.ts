import calendar from '@famos/ext-calendar/server';
import lists from '@famos/ext-lists/server';
import { LlmError, systemActor } from '@famos/sdk';
import { createTestKernel, mention, type TestKernel, understood } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/contract/index.ts';
import { EXTRACT_TIMEOUT_MS, TRANSCRIBE_BUDGET_MS } from '../src/server/budget.ts';
import inbox from '../src/server/index.ts';
import { processItem } from '../src/server/process.ts';

const TZ = 'Europe/Istanbul';
let k: TestKernel;
let parent: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [calendar, lists, inbox] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
	parent = await k.member('admin', 'Ayse');
});
afterEach(() => k.close());

const share = (text: string): Promise<InboxItem> =>
	k.route('inbox.createItem').call({
		body: { channel: 'share', text },
		files: [],
		actor: parent.actor,
	});
/** The list leaves dismissed items out, so an item that shows up again was revived. */
const listed = (): Promise<InboxItem[]> =>
	k.route('inbox.listItems').call({ query: { limit: 30 }, actor: parent.actor });
const draftCount = async () =>
	(
		await k
			.route('core.listDrafts')
			.call({ query: { sourceKind: 'inbox', limit: 50 }, actor: parent.actor })
	).length;

/** Dismisses the item the moment the model is asked, as a person tapping remove mid-read. */
function dismissWhenAsked(id: string) {
	const ask = k.llm.generateObject.bind(k.llm);
	k.llm.generateObject = async (request) => {
		await k.runner.invoke('inbox.dismissItem', { id }, parent.actor);
		return ask(request);
	};
}

describe('an item dismissed while it is being read', () => {
	it('stays dismissed and gets no suggestions', async () => {
		k.llm.respond(
			understood([
				mention('lists.task', { title: 'Pay the fee', date: { text: 'Friday', weekday: 5 } }),
			]),
		);
		const item = await share('Pay the fee by Friday');
		dismissWhenAsked(item.id);
		await k.worker.drain();

		expect(await listed()).toEqual([]);
		expect(await draftCount()).toBe(0);
	});

	it('stays dismissed when the read then fails for good', async () => {
		k.llm.respond(new LlmError('limit_reached', 'out of budget'));
		const item = await share('Pay the fee by Friday');
		dismissWhenAsked(item.id);
		await k.worker.drain();

		expect(await listed()).toEqual([]);
	});

	it('stays dismissed when the AI is turned off under the read', async () => {
		k.llm.respond(new LlmError('disabled', 'off'));
		const item = await share('Pay the fee by Friday');
		dismissWhenAsked(item.id);
		await k.worker.drain();

		expect(await listed()).toEqual([]);
	});
});

describe('the time a reading may take', () => {
	it('covers every step of it', () => {
		expect(processItem.timeoutMs).toBeGreaterThanOrEqual(TRANSCRIBE_BUDGET_MS + EXTRACT_TIMEOUT_MS);
	});
});
