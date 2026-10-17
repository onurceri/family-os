import records from '@famos/ext-records/server';
import { systemActor, type UploadedFile } from '@famos/sdk';
import { createTestKernel, type TestKernel, understood } from '@famos/testing';
import { epochOf } from '@famos/time';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../src/contract/index.ts';
import inbox from '../src/server/index.ts';

const TZ = 'Europe/Istanbul';
const CAR = 'vehicle_00000000-0000-7000-8000-000000000001';
let k: TestKernel;
let admin: Awaited<ReturnType<TestKernel['member']>>;
let kid: Awaited<ReturnType<TestKernel['member']>>;

async function boot(withRecords = true) {
	k = await createTestKernel({ extensions: withRecords ? [inbox, records] : [inbox] });
	await k.runner.invoke('core.updateFamilySettings', { timeZone: TZ }, systemActor('test'));
	k.clock.set(epochOf('2026-10-06', '10:00', TZ));
	admin = await k.member('admin', 'Ayşe');
	kid = await k.member('supervised', 'Elif');
}
beforeEach(() => boot());
afterEach(() => k.close());

const upload = (name: string, text: string, type = 'application/pdf'): UploadedFile => {
	const bytes = new TextEncoder().encode(text);
	return {
		field: 'files',
		name,
		type,
		size: bytes.length,
		bytes: async () => bytes,
		async *stream() {
			yield bytes;
		},
	};
};
const create = (
	body: Record<string, unknown>,
	files: UploadedFile[] = [],
	actor = admin.actor,
): Promise<InboxItem> =>
	k.route('inbox.createItem').call({ body: { channel: 'share', ...body }, files, actor });
const target = { fileToRecordId: CAR, fileToRecordKind: 'vehicle', fileToRecordName: 'Golf' };
const items = (actor = admin.actor): Promise<InboxItem[]> =>
	k.route('inbox.listItems').call({ query: { limit: 30 }, actor });
const papers = () =>
	k.route('records.listDocuments').call({ query: { recordId: CAR } }) as Promise<
		{ name: string; label: string; sourceItemId: string | null }[]
	>;
const jobs = async () =>
	(await sql<{ name: string }>`select name from queue_jobs`.execute(k.ctx.db)).rows.map(
		(r) => r.name,
	);

describe('adding to a record when sharing', () => {
	it('files the papers, never queues reading, and never calls the model', async () => {
		const item = await create({ ...target, fileToLabel: 'policy' }, [
			upload('policy.pdf', 'POLICY 123'),
			upload('card.pdf', 'GREEN CARD'),
		]);
		expect(item).toMatchObject({
			status: 'filed',
			filedTo: { recordId: CAR, recordKind: 'vehicle', label: 'policy', recordName: 'Golf' },
		});
		expect(await papers()).toMatchObject([
			{ name: 'card.pdf', label: 'policy', sourceItemId: item.id },
			{ name: 'policy.pdf', label: 'policy', sourceItemId: item.id },
		]);
		expect(await jobs()).not.toContain('inbox.process');
		await k.worker.drain();
		expect(k.llm.calls).toHaveLength(0);
		expect(k.llm.transcribeCalls).toHaveLength(0);
		expect((await items())[0]).toMatchObject({ id: item.id, status: 'filed' });
	});

	it('opens the filed paper through the record, with the label other by default', async () => {
		await create(target, [upload('invoice.pdf', 'INVOICE')]);
		expect(await papers()).toMatchObject([{ name: 'invoice.pdf', label: 'other' }]);
	});

	it('refuses everything when the member may not change records', async () => {
		await expect(create(target, [upload('policy.pdf', 'x')], kid.actor)).rejects.toMatchObject({
			code: 'forbidden',
		});
		expect(await items(kid.actor)).toHaveLength(0);
		expect(await papers()).toHaveLength(0);
		expect(await jobs()).not.toContain('inbox.process');
	});

	it('refuses a missing file and rolls the item back', async () => {
		const ids = k.ctx.ids;
		const id = ids.next('inbox_item');
		const result = await k.runner
			.invoke(
				'inbox.addItem',
				{
					id,
					channel: 'share',
					files: [{ key: `inbox/${id}/0`, name: 'ghost.pdf', type: 'application/pdf', size: 1 }],
					fileTo: { recordId: CAR, recordKind: 'vehicle' },
				},
				admin.actor,
			)
			.catch((e: unknown) => e);
		expect(result).toMatchObject({ code: 'bad_request' });
		expect(await items()).toHaveLength(0);
	});

	it('needs files to file, and a record to be named in full', async () => {
		await expect(create(target, [])).rejects.toMatchObject({ code: 'bad_request' });
		await expect(
			create({ text: 'hi', fileToRecordId: CAR }, [upload('a.pdf', 'a')]),
		).rejects.toMatchObject({ code: 'bad_request' });
		expect(await items()).toHaveLength(0);
	});

	it('says so plainly when records is not installed, and stores nothing', async () => {
		await k.close();
		await boot(false);
		await expect(create(target, [upload('a.pdf', 'a')])).rejects.toMatchObject({
			code: 'bad_request',
			message: expect.stringContaining('not available'),
		});
		expect(await items()).toHaveLength(0);
	});

	it('still sends an item without “Add to…” to the AI as before', async () => {
		const item = await create({ text: 'School trip on Friday' });
		expect(item.status).toBe('received');
		expect(await jobs()).toContain('inbox.process');
	});
});

describe('filing an item that is already in the Inbox', () => {
	it('files its files, marks it filed, and stops the AI from reading it', async () => {
		const item = await create({ text: 'See attached' }, [upload('policy.pdf', 'POLICY')]);
		expect(item.status).toBe('received');
		const filed = await k.runner.invoke<InboxItem>(
			'inbox.fileItem',
			{ id: item.id, fileTo: { recordId: CAR, recordKind: 'vehicle', label: 'policy' } },
			admin.actor,
		);
		expect(filed).toMatchObject({ status: 'applied', output: { status: 'filed' } });
		expect(await papers()).toMatchObject([{ name: 'policy.pdf', label: 'policy' }]);
		// The reading job was already queued; it finds a filed item and does nothing.
		await k.worker.drain();
		expect(k.llm.calls).toHaveLength(0);
		expect((await items())[0]?.status).toBe('filed');
	});

	it('files an item the AI already read', async () => {
		k.llm.respond(understood([], { label: 'A policy.' }));
		const item = await create({ text: 'See attached' }, [upload('policy.pdf', 'POLICY')]);
		await k.worker.drain();
		expect((await items())[0]?.status).toBe('extracted');
		await k.runner.invoke(
			'inbox.fileItem',
			{ id: item.id, fileTo: { recordId: CAR, recordKind: 'vehicle' } },
			admin.actor,
		);
		expect((await items())[0]).toMatchObject({ status: 'filed', filedTo: { recordId: CAR } });
		expect(await papers()).toHaveLength(1);
	});

	it('is repeatable and refuses other people’s items, items without files, and no permission', async () => {
		const item = await create({ text: 'See attached' }, [upload('policy.pdf', 'POLICY')]);
		const input = { id: item.id, fileTo: { recordId: CAR, recordKind: 'vehicle' } };
		await k.runner.invoke('inbox.fileItem', input, admin.actor);
		await k.runner.invoke('inbox.fileItem', input, admin.actor);
		expect(await papers()).toHaveLength(1);

		// Someone who may not see everyone's items cannot file another person's.
		const mine = await create({ text: 'See attached' }, [upload('b.pdf', 'B')]);
		const sibling = await k.member('supervised', 'Sibling');
		await expect(
			k.runner.invoke('inbox.fileItem', { ...input, id: mine.id }, sibling.actor),
		).rejects.toMatchObject({ code: 'forbidden' });

		const textOnly = await create({ text: 'No files' });
		await expect(
			k.runner.invoke('inbox.fileItem', { ...input, id: textOnly.id }, admin.actor),
		).rejects.toMatchObject({ code: 'bad_request' });

		const kidItem = await create({ text: 'Mine' }, [upload('k.pdf', 'K')], kid.actor);
		await expect(
			k.runner.invoke('inbox.fileItem', { ...input, id: kidItem.id }, kid.actor),
		).rejects.toMatchObject({ code: 'forbidden' });
		expect((await items(kid.actor))[0]?.status).not.toBe('filed');
	});
});
