import records from '@famos/ext-records/server';
import { systemActor, type UploadedFile } from '@famos/sdk';
import { createTestKernel, type TestKernel } from '@famos/testing';
import { epochOf } from '@famos/time';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/contract/index.ts';
import { SWEEP_EVERY_MS } from '../src/server/budget.ts';
import inbox from '../src/server/index.ts';
import { PURGE_BATCH } from '../src/server/purge.ts';
import type { InboxTables } from '../src/server/store.ts';

const TZ = 'Europe/Istanbul';
const CAR = 'vehicle_00000000-0000-7000-8000-000000000001';
let k: TestKernel;
let ayse: Awaited<ReturnType<TestKernel['member']>>;

beforeEach(async () => {
	k = await createTestKernel({ extensions: [inbox, records] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
	ayse = await k.member('admin', 'Ayse');
	// The sweep planned at start is overdue now the clock moved: let it run once, so the next
	// one is a slot away.
	await k.worker.drain();
});
afterEach(() => k.close());

const upload = (name: string, text: string): UploadedFile => {
	const bytes = new TextEncoder().encode(text);
	return {
		field: 'files',
		name,
		type: 'application/pdf',
		size: bytes.length,
		bytes: async () => bytes,
		async *stream() {
			yield bytes;
		},
	};
};
const create = (body: Record<string, unknown>, files: UploadedFile[]): Promise<InboxItem> =>
	k
		.route('inbox.createItem')
		.call({ body: { channel: 'share', ...body }, files, actor: ayse.actor });
const dismiss = (id: string) => k.runner.invoke('inbox.dismissItem', { id }, ayse.actor);
const served = (id: string) =>
	k.route('inbox.getItemFile').call({ params: { itemId: id, index: 0 }, actor: ayse.actor });
const onDisk = async (id: string) => (await k.ctx.files.stat(`inbox/${id}/0`)) !== null;
const db = () => k.ctx.db.withTables<InboxTables>();

describe('the files of a dismissed item', () => {
	it('are no longer served once the item is dismissed', async () => {
		const item = await create({ text: 'See attached' }, [upload('a.pdf', 'A')]);
		await expect(served(item.id)).resolves.toMatchObject({ filename: 'a.pdf' });
		await dismiss(item.id);
		await expect(served(item.id)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('are deleted by a job queued with the dismissal, and a second run changes nothing', async () => {
		const item = await create({ text: 'See attached' }, [
			upload('a.pdf', 'A'),
			upload('b.pdf', 'B'),
		]);
		await k.worker.drain();
		await dismiss(item.id);
		expect(await onDisk(item.id)).toBe(true);
		await k.worker.drain();
		expect(await onDisk(item.id)).toBe(false);
		expect(await k.ctx.files.stat(`inbox/${item.id}/1`)).toBeNull();

		// Run again, as a retry or an overlapping sweep would: nothing breaks, nothing comes back.
		await k.ctx.enqueue('inbox.removeFiles', { itemId: item.id });
		await k.worker.drain();
		expect(await onDisk(item.id)).toBe(false);
	});

	it('are kept when a record holds them', async () => {
		const item = await create({ text: 'Policy' }, [upload('policy.pdf', 'POLICY')]);
		await k.runner.invoke(
			'inbox.fileItem',
			{ id: item.id, fileTo: { recordId: CAR, recordKind: 'vehicle' } },
			ayse.actor,
		);
		await dismiss(item.id);
		await k.worker.drain();
		expect(await onDisk(item.id)).toBe(true);
		const papers = (await k.route('records.listDocuments').call({ query: { recordId: CAR } })) as {
			name: string;
		}[];
		expect(papers.map((p) => p.name)).toEqual(['policy.pdf']);
	});

	it('are deleted for items dismissed before, a batch per sweep, and only once', async () => {
		const old = await create({ text: 'Old' }, [upload('old.pdf', 'OLD')]);
		// As it was before files went with a dismissal: the status changed, nothing else.
		await db()
			.updateTable('inbox_items')
			.set({ status: 'dismissed' })
			.where('id', '=', old.id)
			.execute();
		await k.worker.drain();
		expect(await onDisk(old.id)).toBe(true);

		k.clock.advance(SWEEP_EVERY_MS);
		await k.worker.drain();
		expect(await onDisk(old.id)).toBe(false);
		const row = await db()
			.selectFrom('inbox_items')
			.selectAll()
			.where('id', '=', old.id)
			.executeTakeFirst();
		expect(row?.files_removed_at).not.toBeNull();
	});

	it('are cleaned up at most a batch per sweep', async () => {
		const ids: string[] = [];
		for (let i = 0; i < PURGE_BATCH + 2; i++) {
			const item = await create({ text: `n${i}` }, [upload('a.pdf', 'A')]);
			ids.push(item.id);
		}
		await db().updateTable('inbox_items').set({ status: 'dismissed' }).execute();
		await k.worker.drain();
		k.clock.advance(SWEEP_EVERY_MS);
		await k.worker.drain();
		const left = await Promise.all(ids.map(onDisk));
		expect(left.filter(Boolean)).toHaveLength(2);
		k.clock.advance(SWEEP_EVERY_MS);
		await k.worker.drain();
		expect((await Promise.all(ids.map(onDisk))).filter(Boolean)).toHaveLength(0);
	});
});
