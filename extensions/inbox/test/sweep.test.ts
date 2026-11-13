import { createTestKernel, type TestKernel } from '@famos/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/contract/index.ts';
import { READ_MAX_LIFE_MS } from '../src/server/budget.ts';
import inbox from '../src/server/index.ts';
import type { InboxTables } from '../src/server/store.ts';

let k: TestKernel;
let ayse: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [inbox] });
	ayse = await k.member('admin', 'Ayse');
});
afterEach(() => k.close());

/** An item whose reading job ended without a word: it never left `received` or `normalized`. */
async function stuckItem(id: string, status: 'received' | 'normalized' | 'extracted') {
	const now = k.clock.now();
	await k.ctx.db
		.withTables<InboxTables>()
		.insertInto('inbox_items')
		.values({
			id,
			channel: 'share',
			title: null,
			text: 'Pay the fee by Friday',
			url: null,
			files: '[]',
			status,
			filed_to: null,
			normalized_text: null,
			transcript: null,
			summary: null,
			kind: null,
			error_code: null,
			read_attempt: null,
			proposals: 0,
			skipped: 0,
			skipped_unknown: 0,
			skips: '[]',
			model: null,
			extraction: 0,
			created_by: ayse.member.id,
			created_at: now,
			updated_at: now,
		})
		.execute();
}
const statusOf = async (id: string) =>
	(await k.route('inbox.listItems').call({ query: { limit: 30 }, actor: ayse.actor })).find(
		(item: InboxItem) => item.id === id,
	)?.status;

describe('the sweep of items left unread', () => {
	it('fails an item left past the longest reading, and Retry then works', async () => {
		await stuckItem('inbox_item_01900000-0000-7000-8000-000000000001', 'normalized');
		k.clock.advance(READ_MAX_LIFE_MS + 1);
		await k.worker.drain();

		expect(await statusOf('inbox_item_01900000-0000-7000-8000-000000000001')).toBe('failed');
		const again = await k.runner.invoke(
			'inbox.retryItem',
			{ id: 'inbox_item_01900000-0000-7000-8000-000000000001' },
			ayse.actor,
		);
		expect(again.status).toBe('applied');
		expect(await statusOf('inbox_item_01900000-0000-7000-8000-000000000001')).toBe('received');
	});

	it('leaves an item inside the limit, and one already read, alone', async () => {
		await stuckItem('inbox_item_01900000-0000-7000-8000-000000000002', 'received');
		await stuckItem('inbox_item_01900000-0000-7000-8000-000000000003', 'extracted');
		k.clock.advance(READ_MAX_LIFE_MS - 60 * 60_000);
		await stuckItem('inbox_item_01900000-0000-7000-8000-000000000004', 'received');
		await k.worker.drain();

		expect(await statusOf('inbox_item_01900000-0000-7000-8000-000000000002')).toBe('received');
		expect(await statusOf('inbox_item_01900000-0000-7000-8000-000000000003')).toBe('extracted');
		expect(await statusOf('inbox_item_01900000-0000-7000-8000-000000000004')).toBe('received');
	});
});
