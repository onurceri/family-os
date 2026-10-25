import { DAY_MS, defineAction, defineCapability, systemActor } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	DECIDED_DRAFTS_KEEP_MS,
	NOTIFICATIONS_KEEP_MS,
	PRUNE_HISTORY_JOB,
} from '../src/retention.ts';
import type { CoreTables, DraftStatus } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const shelfUse = defineCapability({ id: 'shelf.use', label: 'shelf:cap_use', level: 'use' });

const shelf = defineTestExtension({
	id: 'shelf',
	capabilities: [shelfUse],
	actions: [
		defineAction({
			id: 'shelf.tidy',
			title: 'Tidy the shelf',
			input: z.object({ note: z.string() }),
			output: z.object({ ok: z.boolean() }),
			requires: shelfUse.id,
			async run() {
				return { ok: true };
			},
		}),
		defineAction({
			id: 'shelf.put',
			title: 'Put a thing on the shelf',
			input: z.object({ note: z.string() }),
			output: z.object({ id: z.string() }),
			requires: shelfUse.id,
			undo: ({ id }) => ({ actionId: 'shelf.take', input: { id } }),
			async run() {
				return { id: 'thing_1' };
			},
		}),
		defineAction({
			id: 'shelf.take',
			title: 'Take a thing off the shelf',
			input: z.object({ id: z.string() }),
			output: z.object({ ok: z.boolean() }),
			requires: shelfUse.id,
			async run() {
				return { ok: true };
			},
		}),
	],
});

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [shelf] });
});
afterEach(() => k.close());

const core = () => k.ctx.db.withTables<CoreTables>();

let n = 0;
async function draft(status: DraftStatus, decidedAgo: number, actionId = 'shelf.tidy') {
	const id = `draft_${String(++n).padStart(3, '0')}_${status}`;
	const at = k.clock.now() - decidedAgo;
	await core()
		.insertInto('core_drafts')
		.values({
			id,
			action_id: actionId,
			input: JSON.stringify({ note: id }),
			edited_input: null,
			status,
			proposed_by: JSON.stringify(systemActor('test')),
			source_kind: null,
			source_id: null,
			summary: null,
			model: null,
			prompt_version: null,
			confidence: null,
			uncertain_fields: null,
			quote: null,
			dedupe_key: null,
			decided_by: null,
			decided_at: status === 'pending' || status === 'failed' ? null : at,
			applied_at: status === 'applied' ? at : null,
			result:
				status === 'applied'
					? JSON.stringify(actionId === 'shelf.tidy' ? { ok: true } : { id: 'thing_1' })
					: null,
			error: null,
			for_member: null,
			replaced: null,
			created_at: at - 1000,
			updated_at: at,
		})
		.execute();
	return id;
}

async function notification(memberId: string, ago: number, read: boolean) {
	const id = `notif_${String(++n).padStart(3, '0')}`;
	await core()
		.insertInto('core_notifications')
		.values({
			id,
			member_id: memberId,
			kind: 'core.draftWaiting',
			title_key: 'core:x',
			title_params: null,
			body_key: null,
			body_params: null,
			url: null,
			source_kind: null,
			source_id: null,
			dedupe_key: null,
			created_at: k.clock.now() - ago,
			read_at: read ? k.clock.now() - ago : null,
		})
		.execute();
	return id;
}

const prune = async () => {
	await k.ctx.enqueue(PRUNE_HISTORY_JOB, {});
	await k.worker.drain();
};
const left = async (table: 'core_drafts' | 'core_notifications') =>
	(await core().selectFrom(table).select('id').orderBy('id').execute()).map((r) => r.id);

describe('keeping history for a while', () => {
	it('removes suggestions decided long ago, but not those still waiting or still undoable', async () => {
		const old = DECIDED_DRAFTS_KEEP_MS + DAY_MS;
		const recent = DECIDED_DRAFTS_KEEP_MS - DAY_MS;
		await draft('rejected', old);
		await draft('expired', old);
		await draft('undone', old);
		await draft('applied', old);
		const undoable = await draft('applied', old, 'shelf.put');
		// Its extension is not installed now: a reinstall may offer its undo again.
		const notInstalled = await draft('applied', old, 'gone.thing');
		const pending = await draft('pending', old);
		const failed = await draft('failed', old);
		const rejectedRecently = await draft('rejected', recent);
		const appliedRecently = await draft('applied', recent);
		const auditBefore = await core().selectFrom('core_audit_log').select('id').execute();

		await prune();
		const kept = [undoable, notInstalled, pending, failed, rejectedRecently, appliedRecently];
		expect(await left('core_drafts')).toEqual(kept.toSorted());
		// Again changes nothing.
		await prune();
		expect(await left('core_drafts')).toEqual(kept.toSorted());
		// The audit log is history: it stays.
		expect(await core().selectFrom('core_audit_log').select('id').execute()).toEqual(auditBefore);
	});

	it('removes notifications older than the window, read or not, and tells whose count went down', async () => {
		const { member: a } = await k.member('admin');
		const { member: b } = await k.member('admin');
		const old = NOTIFICATIONS_KEEP_MS + DAY_MS;
		await notification(a.id, old, false);
		await notification(b.id, old, true);
		const fresh = await notification(a.id, DAY_MS, false);
		const heard: unknown[] = [];
		k.bus.onAny((name, payload) => {
			if (name === 'core.notification.read') heard.push(payload);
		});

		await prune();
		expect(await left('core_notifications')).toEqual([fresh]);
		expect(heard).toEqual([{ memberId: a.id }]);
	});

	it('runs once a day by itself', async () => {
		const at = k.clock.now();
		await draft('rejected', DECIDED_DRAFTS_KEEP_MS - DAY_MS / 2);
		// The first run is a day after start; then it schedules the next one.
		k.clock.advance(DAY_MS + 1000);
		await k.worker.drain();
		expect(await left('core_drafts')).toEqual([]);
		const next = await k.ctx.db
			.selectFrom('queue_jobs' as never)
			.select(['name', 'run_at'] as never[])
			.execute();
		expect(
			(next as unknown as { name: string; run_at: number }[]).some(
				(job) => job.name === PRUNE_HISTORY_JOB && job.run_at > at + DAY_MS,
			),
		).toBe(true);
	});
});
