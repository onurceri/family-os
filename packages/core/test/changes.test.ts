import {
	type Actor,
	addVersion,
	bumpParentVersion,
	defineAction,
	defineCapability,
	defineEvent,
	defineJob,
	isFamosError,
	type MemberId,
} from '@famos/sdk';
import { type Generated, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CHANGES_KEEP_MS, PRUNE_CHANGES_JOB } from '../src/changes.ts';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

const thingsView = defineCapability({ id: 'things.view', label: 'things:cap_view', level: 'view' });
const thingsEdit = defineCapability({ id: 'things.edit', label: 'things:cap_edit', level: 'edit' });

type ThingsTables = {
	things_items: {
		id: string;
		title: string;
		owner: string | null;
		pinned: number;
		updated_at: number;
		version: Generated<number>;
	};
	things_marks: { id: string; item_id: string };
};

const op = z.enum(['upsert', 'delete']).optional();
/** A thing with an owner is told to its owner alone; the rest to whoever may see things. */
const changed = defineEvent(
	'things.item.changed',
	z.object({ id: z.string(), owner: z.string().nullable().optional(), op }),
	{
		audience: ({ owner }) => (owner ? [{ member: owner }] : ['things.view']),
		changes: ({ id, op: what }) => [{ entity: 'item', id, op: what ?? 'upsert' }],
	},
);
/** Told, but not kept in the change log. */
const noted = defineEvent('things.noted', z.object({}));

const db = (uow: { db: import('@famos/sdk').DbExecutor }) => uow.db.withTables<ThingsTables>();

const add = defineAction({
	id: 'things.add',
	title: 'Add a thing',
	input: z.object({ id: z.string(), owner: z.string().optional(), fail: z.boolean().optional() }),
	output: z.object({ id: z.string() }),
	requires: thingsEdit.id,
	async run(uow, { id, owner, fail }) {
		await db(uow)
			.insertInto('things_items')
			.values({ id, title: id, owner: owner ?? null, pinned: 0, updated_at: 1 })
			.execute();
		uow.emit(changed, { id, owner: owner ?? null });
		uow.emit(noted, {});
		if (fail) throw new Error('rolled back');
		return { id };
	},
});
const rename = defineAction({
	id: 'things.rename',
	title: 'Rename a thing',
	target: ({ id }) => ({ table: 'things_items', id, versionColumn: 'version' }),
	input: z.object({ id: z.string(), title: z.string() }),
	output: z.object({ ok: z.literal(true) }),
	requires: thingsEdit.id,
	async run(uow, { id, title }) {
		await db(uow).updateTable('things_items').set({ title }).where('id', '=', id).execute();
		uow.emit(changed, { id });
		return { ok: true as const };
	},
});
/** A write that leaves `updated_at` alone, as a pin or a reorder does. */
const pin = defineAction({
	id: 'things.pin',
	title: 'Pin a thing',
	input: z.object({ id: z.string() }),
	output: z.object({ ok: z.literal(true) }),
	requires: thingsEdit.id,
	async run(uow, { id }) {
		await db(uow).updateTable('things_items').set({ pinned: 1 }).where('id', '=', id).execute();
		return { ok: true as const };
	},
});
const mark = defineAction({
	id: 'things.mark',
	title: 'Mark a thing',
	input: z.object({ id: z.string(), itemId: z.string() }),
	output: z.object({ ok: z.literal(true) }),
	requires: thingsEdit.id,
	async run(uow, { id, itemId }) {
		await db(uow).insertInto('things_marks').values({ id, item_id: itemId }).execute();
		return { ok: true as const };
	},
});
const unmark = defineAction({
	id: 'things.unmark',
	title: 'Unmark a thing',
	input: z.object({ id: z.string() }),
	output: z.object({ ok: z.literal(true) }),
	requires: thingsEdit.id,
	async run(uow, { id }) {
		await db(uow).deleteFrom('things_marks').where('id', '=', id).execute();
		return { ok: true as const };
	},
});
const remove = defineAction({
	id: 'things.remove',
	title: 'Remove a thing',
	input: z.object({ id: z.string() }),
	output: z.object({ ok: z.literal(true) }),
	requires: thingsEdit.id,
	async run(uow, { id }) {
		await db(uow).deleteFrom('things_items').where('id', '=', id).execute();
		uow.emit(changed, { id, op: 'delete' });
		return { ok: true as const };
	},
});
const noTarget = defineAction({
	id: 'things.noTarget',
	title: 'Do something that names no row',
	input: z.object({}),
	output: z.object({}),
	requires: thingsEdit.id,
	async run() {
		return {};
	},
});

/** A job that writes its own table: the write and its change-log row are one transaction. */
const sweep = defineJob({
	name: 'things.sweep',
	payload: z.object({ id: z.string(), fail: z.boolean().optional() }),
	maxAttempts: 1,
	async handle(ctx, { id, fail }) {
		await ctx.unit(async (uow) => {
			await db(uow).deleteFrom('things_items').where('id', '=', id).execute();
			uow.emit(changed, { id, op: 'delete' });
			if (fail) throw new Error('rolled back');
		});
	},
});

const things = defineTestExtension({
	id: 'things',
	capabilities: [thingsView, thingsEdit],
	migrations: {
		'0001_init': {
			async up(database) {
				await database.schema
					.createTable('things_items')
					.addColumn('id', 'text', (c) => c.primaryKey())
					.addColumn('title', 'text', (c) => c.notNull())
					.addColumn('owner', 'text')
					.addColumn('pinned', 'integer', (c) => c.notNull())
					.addColumn('updated_at', 'integer', (c) => c.notNull())
					.modifyEnd(sql`strict`)
					.execute();
				await database.schema
					.createTable('things_marks')
					.addColumn('id', 'text', (c) => c.primaryKey())
					.addColumn('item_id', 'text', (c) => c.notNull())
					.modifyEnd(sql`strict`)
					.execute();
				await addVersion(database, 'things_items');
				await bumpParentVersion(database, {
					parent: 'things_items',
					child: 'things_marks',
					childKey: 'item_id',
				});
			},
		},
	},
	actions: [add, rename, pin, mark, unmark, remove, noTarget],
	jobs: [sweep],
	events: [changed, noted],
});

let k: TestKernel;
let admin: Actor;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [things] });
	admin = (await k.member('admin')).actor;
});
afterEach(() => k.close());

const run = (id: string, input: unknown, actor: Actor = admin, options = {}) =>
	k.runner.invoke(id, input, actor, options);
const log = () =>
	k.ctx.db.withTables<CoreTables>().selectFrom('core_changes').selectAll().orderBy('seq').execute();
const versionOf = async (id: string) =>
	(
		await db(k.contextFor('things'))
			.selectFrom('things_items')
			.select('version')
			.where('id', '=', id)
			.executeTakeFirstOrThrow()
	).version;
const codeOf = (promise: Promise<unknown>) =>
	promise.then(
		() => 'ok',
		(e: unknown) => (isFamosError(e) ? e.code : 'other'),
	);

describe('the change log', () => {
	it('keeps one row per thing an event names, written with the change', async () => {
		await run('things.add', { id: 'a' });
		await run('things.rename', { id: 'a', title: 'A2' });
		await run('things.add', { id: 'b' });
		const rows = await log();
		// Two edits of "a" are one row: the later one.
		expect(rows.map((r) => [r.extension, r.entity, r.entity_id, r.op])).toEqual([
			['things', 'item', 'a', 'upsert'],
			['things', 'item', 'a', 'upsert'],
			['things', 'item', 'b', 'upsert'],
		]);
		expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
		expect(JSON.parse(rows[0]?.audience ?? '')).toEqual(['things.view']);
	});

	it('leaves nothing for an event that names no thing, or for a rolled back change', async () => {
		await run('things.noTarget', {});
		await expect(run('things.add', { id: 'x', fail: true })).rejects.toThrow('rolled back');
		expect(await log()).toEqual([]);
		await run('things.add', { id: 'y' });
		expect(await log()).toHaveLength(1);
	});

	it('records a removal as a delete', async () => {
		await run('things.add', { id: 'a' });
		await run('things.remove', { id: 'a' });
		const rows = await log();
		expect(rows.at(-1)).toMatchObject({ entity_id: 'a', op: 'delete' });
	});

	it('records what a job writes, in the same transaction', async () => {
		await run('things.add', { id: 'a' });
		await run('things.add', { id: 'b' });
		await k.ctx.enqueue('things.sweep', { id: 'a' });
		await k.worker.drain();
		expect((await log()).at(-1)).toMatchObject({ entity_id: 'a', op: 'delete' });
		expect(
			await db(k.contextFor('things')).selectFrom('things_items').select('id').execute(),
		).toEqual([{ id: 'b' }]);

		// A job that fails inside its unit leaves neither the delete nor the row.
		const before = (await log()).length;
		await k.ctx.enqueue('things.sweep', { id: 'b', fail: true });
		await k.worker.drain();
		expect(await log()).toHaveLength(before);
		expect(
			await db(k.contextFor('things')).selectFrom('things_items').select('id').execute(),
		).toEqual([{ id: 'b' }]);
	});
});

describe('changesSince', () => {
	it('reads from a cursor and leaves out what the actor may not hear', async () => {
		const a = (await k.member('member')).actor as Actor & { kind: 'member' };
		const b = (await k.member('member')).actor as Actor & { kind: 'member' };
		await run('things.add', { id: 'public' });
		await run('things.add', { id: 'mine', owner: a.memberId });
		const seeA = await k.changes.since(0, a);
		expect(seeA.changes.map((c) => c.id)).toEqual(['public', 'mine']);
		const seeB = await k.changes.since(0, b);
		expect(seeB.changes.map((c) => c.id)).toEqual(['public']);
		// B moves on past what it could not hear.
		expect(seeB.cursor).toBe(seeA.cursor);
		expect((await k.changes.since(seeA.cursor, a)).changes).toEqual([]);
	});

	it('filters a display by the capabilities it was granted', async () => {
		await run('things.add', { id: 'a' });
		const display = (capabilities: string[]): Actor => ({
			kind: 'display',
			deviceId: 'device_1',
			capabilities,
			showNames: false,
		});
		expect((await k.changes.since(0, display([]))).changes).toEqual([]);
		expect((await k.changes.since(0, display(['things.view']))).changes).toHaveLength(1);
	});

	it('filters an agent by what the member it works for may hear', async () => {
		const a = (await k.member('member')).actor as Actor & { kind: 'member' };
		await run('things.add', { id: 'mine', owner: a.memberId });
		const agent = (onBehalfOf?: MemberId): Actor => ({
			kind: 'ai',
			mode: 'agent',
			source: 'mcp',
			...(onBehalfOf && { onBehalfOf, roleId: 'member' }),
		});
		expect((await k.changes.since(0, agent(a.memberId))).changes).toHaveLength(1);
		expect((await k.changes.since(0, agent())).changes).toEqual([]);
	});

	it('answers each thing once, with its latest state', async () => {
		await run('things.add', { id: 'a' });
		await run('things.rename', { id: 'a', title: 'x' });
		await run('things.remove', { id: 'a' });
		const page = await k.changes.since(0, admin);
		expect(page.changes.map((c) => [c.id, c.op])).toEqual([['a', 'delete']]);
	});

	it('refuses a cursor older than what is kept, and one from another history', async () => {
		await run('things.add', { id: 'a' });
		k.clock.advance(CHANGES_KEEP_MS + 1000);
		await run('things.add', { id: 'b' });
		// The job a day later, as the schedule runs it.
		await k.ctx.enqueue(PRUNE_CHANGES_JOB, {});
		await k.worker.drain();
		expect((await log()).map((r) => r.entity_id)).toEqual(['b']);
		// Seq 1 was pruned: a client at 0 has missed it and starts over; at 1 it has missed nothing.
		expect(await codeOf(k.changes.since(0, admin))).toBe('gone');
		expect((await k.changes.since(1, admin)).changes.map((c) => c.id)).toEqual(['b']);
		expect(await codeOf(k.changes.since(99, admin))).toBe('gone');
	});

	it('knows the newest seq even when every row was pruned', async () => {
		await run('things.add', { id: 'a' });
		k.clock.advance(CHANGES_KEEP_MS + 1000);
		await k.ctx.enqueue(PRUNE_CHANGES_JOB, {});
		await k.worker.drain();
		expect(await log()).toEqual([]);
		expect(await k.changes.head()).toBe(1);
		expect((await k.changes.since(1, admin)).changes).toEqual([]);
		expect(await codeOf(k.changes.since(0, admin))).toBe('gone');
	});
});

describe('collectionTag', () => {
	it('changes with the log, the actor capabilities and the window', async () => {
		const display = (capabilities: string[]): Actor => ({
			kind: 'display',
			deviceId: 'device_1',
			capabilities,
			showNames: false,
		});
		const first = await k.changes.collectionTag('things', admin, '2026-01-01');
		expect(await k.changes.collectionTag('things', admin, '2026-01-01')).toBe(first);
		expect(await k.changes.collectionTag('things', admin, '2026-01-02')).not.toBe(first);
		expect(
			await k.changes.collectionTag('things', display(['things.view']), '2026-01-01'),
		).not.toBe(first);
		await run('things.add', { id: 'a' });
		const second = await k.changes.collectionTag('things', admin, '2026-01-01');
		expect(second).not.toBe(first);
		// Another extension's change does not move this collection's tag.
		await k.runner.invoke('core.createMember', { displayName: 'Z', roleId: 'member' }, admin);
		expect(await k.changes.collectionTag('things', admin, '2026-01-01')).toBe(second);
	});
});

describe('versions', () => {
	it('start at 0 and count every write, also the ones that skip updated_at', async () => {
		await run('things.add', { id: 'a' });
		expect(await versionOf('a')).toBe(0);
		await run('things.rename', { id: 'a', title: 'B' });
		expect(await versionOf('a')).toBe(1);
		await run('things.pin', { id: 'a' });
		expect(await versionOf('a')).toBe(2);
		const row = await db(k.contextFor('things'))
			.selectFrom('things_items')
			.select('updated_at')
			.where('id', '=', 'a')
			.executeTakeFirstOrThrow();
		expect(row.updated_at).toBe(1);
	});

	it('raise the parent when a child it shows is added, changed or removed', async () => {
		await run('things.add', { id: 'a' });
		await run('things.mark', { id: 'm1', itemId: 'a' });
		expect(await versionOf('a')).toBe(1);
		await run('things.unmark', { id: 'm1' });
		expect(await versionOf('a')).toBe(2);
	});
});

describe('conditional writes', () => {
	it('runs when the version is the one the caller read', async () => {
		await run('things.add', { id: 'a' });
		await run('things.rename', { id: 'a', title: 'B' }, admin, { ifMatch: 0 });
		expect(await versionOf('a')).toBe(1);
	});

	it('refuses with precondition_failed when the row moved on, and changes nothing', async () => {
		await run('things.add', { id: 'a' });
		await run('things.pin', { id: 'a' });
		const before = (await log()).length;
		const error = await run('things.rename', { id: 'a', title: 'B' }, admin, {
			ifMatch: 0,
		}).catch((e: unknown) => e);
		expect(isFamosError(error) && error.code).toBe('precondition_failed');
		expect(isFamosError(error) && error.details).toEqual({ version: 1 });
		expect(await versionOf('a')).toBe(1);
		expect(await log()).toHaveLength(before);
	});

	it('maps to 412', async () => {
		const { ERROR_HTTP_STATUS } = await import('@famos/sdk');
		expect(ERROR_HTTP_STATUS.precondition_failed).toBe(412);
		expect(ERROR_HTTP_STATUS.gone).toBe(410);
	});

	it('refuses a condition on an action that names no versioned row', async () => {
		expect(await codeOf(run('things.noTarget', {}, admin, { ifMatch: 0 }))).toBe('bad_request');
	});

	it('says not found when the row is not there', async () => {
		expect(
			await codeOf(run('things.rename', { id: 'nope', title: 'B' }, admin, { ifMatch: 0 })),
		).toBe('not_found');
	});
});
