import {
	type Actor,
	defineAction,
	defineCapability,
	defineExtension,
	defineJob,
	defineRoute,
	type ExtensionContext,
	type Migration,
	SDK_VERSION,
	type ShareTarget,
	systemActor,
} from '@famos/sdk';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CoreTables } from '../src/tables.ts';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// Two extensions: notes calls one of tasks' actions (listed in its manifest), and nothing else.
type NotesTables = { notes_items: { id: string; text: string } };
type TasksTables = { tasks_items: { id: string } };

const table =
	(name: string): Migration['up'] =>
	(db) =>
		db.schema
			.createTable(name)
			.addColumn('id', 'text', (c) => c.primaryKey())
			.addColumn('text', 'text')
			.execute();

const notesUse = defineCapability({ id: 'notes.use', label: 'notes:cap', level: 'use' });
const tasksUse = defineCapability({ id: 'tasks.use', label: 'tasks:cap', level: 'use' });

const countTasks = defineAction({
	id: 'tasks.count',
	title: 'Count tasks',
	input: z.object({}),
	output: z.number(),
	readOnly: true,
	async run(uow) {
		const rows = await uow.db
			.withTables<TasksTables>()
			.selectFrom('tasks_items')
			.selectAll()
			.execute();
		return rows.length;
	},
});
const tasksForAi = defineAction({
	id: 'tasks.forAi',
	title: 'Tasks for the AI',
	input: z.object({}),
	output: z.number(),
	readOnly: true,
	ai: { description: 'Counts tasks.' },
	run: async () => 1,
});
const tasksPrivate = defineAction({
	id: 'tasks.private',
	title: 'Not for others',
	input: z.object({}),
	output: z.number(),
	readOnly: true,
	run: async () => 2,
});
const addTask = defineAction({
	id: 'tasks.add',
	title: 'Add a task',
	input: z.object({ id: z.string() }),
	output: z.object({ ok: z.literal(true) }),
	requires: tasksUse.id,
	approval: 'never',
	async run(uow, { id }) {
		await uow.db.withTables<TasksTables>().insertInto('tasks_items').values({ id }).execute();
		return { ok: true as const };
	},
});

let registered: ExtensionContext | undefined;
let jobCtx: ExtensionContext | undefined;
let shareCtx: ExtensionContext | undefined;

const shareTarget: ShareTarget = {
	requires: notesUse.id,
	limits: { maxFiles: 1, maxBytes: 10, accept: ['text/plain'] },
	async receive(ctx) {
		shareCtx = ctx;
	},
};

const notes = defineTestExtension({
	id: 'notes',
	dependsOn: ['tasks'],
	calls: ['tasks.count'],
	capabilities: [notesUse],
	shareTarget,
	migrations: { '0001_items': { up: table('notes_items') } },
	actions: [
		defineAction({
			id: 'notes.add',
			title: 'Add a note',
			input: z.object({ id: z.string(), text: z.string(), fail: z.boolean().default(false) }),
			output: z.object({ ok: z.literal(true) }),
			requires: notesUse.id,
			approval: 'never',
			async run(uow, { id, text, fail }) {
				await uow.db
					.withTables<NotesTables>()
					.insertInto('notes_items')
					.values({ id, text })
					.execute();
				await uow.files.grant(`notes/${id}`, 'tasks');
				if (fail) throw new Error('rolled back');
				return { ok: true as const };
			},
		}),
		defineAction({
			id: 'notes.members',
			title: 'Read members',
			input: z.object({}),
			output: z.number(),
			readOnly: true,
			async run(uow) {
				const rows = await uow.db
					.withTables<CoreTables>()
					.selectFrom('core_members')
					.selectAll()
					.execute();
				return rows.length;
			},
		}),
		defineAction({
			id: 'notes.family',
			title: 'Read the family',
			input: z.object({}),
			output: z.number(),
			readOnly: true,
			async run(uow) {
				return (await uow.family.members()).length;
			},
		}),
		defineAction({
			id: 'notes.call',
			title: 'Run another action',
			input: z.object({ target: z.string() }),
			output: z.unknown(),
			readOnly: true,
			run: (uow, { target }) => uow.run(target, {}),
		}),
	],
	jobs: [
		defineJob({
			name: 'notes.look',
			payload: z.object({}),
			async handle(ctx) {
				jobCtx = ctx;
			},
		}),
	],
	routes: [
		defineRoute({
			method: 'get',
			path: '/members',
			operationId: 'notes.members',
			summary: 'Members, read directly',
			requires: 'public',
			response: z.number(),
			async handle(ctx) {
				const rows = await ctx.db
					.withTables<CoreTables>()
					.selectFrom('core_members')
					.selectAll()
					.execute();
				return rows.length;
			},
		}),
	],
	register(ctx) {
		registered = ctx;
	},
});
const tasks = defineTestExtension({
	id: 'tasks',
	capabilities: [tasksUse],
	migrations: { '0001_items': { up: table('tasks_items') } },
	actions: [countTasks, tasksForAi, tasksPrivate, addTask],
});

const forbidden = { code: 'forbidden' };
const system = systemActor('test');
const ai: Actor = { kind: 'ai', mode: 'agent', source: 'notes' };

let k: TestKernel;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [notes, tasks] });
});
afterEach(() => k.close());

const run = (id: string, input: unknown = {}, actor: Actor = system) =>
	k.runner.invoke(id, input, actor);

describe('the database', () => {
	it('keeps an action to its own tables; members come through the family', async () => {
		await expect(run('notes.members')).rejects.toMatchObject(forbidden);
		await expect(run('notes.family')).resolves.toMatchObject({ status: 'applied' });
		await expect(run('notes.add', { id: 'n1', text: 'hi' })).resolves.toMatchObject({
			status: 'applied',
		});
	});

	it('gives a route its own extension’s context', async () => {
		await expect(k.route('notes.members').call()).rejects.toMatchObject(forbidden);
	});

	it('allows aliases and common table expressions, but not one named like a foreign table', async () => {
		const db = k.contextFor('notes').db.withTables<NotesTables>();
		await db.insertInto('notes_items').values({ id: 'a', text: 'x' }).execute();
		const aliased = await db
			.selectFrom('notes_items as n')
			.select(['n.id', sql<number>`count(*)`.as('n')])
			.groupBy('n.id')
			.execute();
		expect(aliased).toEqual([{ id: 'a', n: 1 }]);
		const recent = await db
			.with('recent', (qb) => qb.selectFrom('notes_items').select('id'))
			.selectFrom('recent')
			.selectAll()
			.execute();
		expect(recent).toEqual([{ id: 'a' }]);
		await expect(
			db
				.with('tasks_items', (qb) => qb.selectFrom('notes_items').select('id'))
				.selectFrom('tasks_items')
				.selectAll()
				.execute(),
		).rejects.toMatchObject(forbidden);
		await expect(
			sql`select id from tasks_items`.execute(k.contextFor('notes').db),
		).rejects.toMatchObject(forbidden);
	});

	it('keeps the scope in a transaction the extension opens itself', async () => {
		const ctx = k.contextFor('notes');
		await expect(
			ctx.db
				.transaction()
				.execute((trx) =>
					trx.withTables<TasksTables>().selectFrom('tasks_items').selectAll().execute(),
				),
		).rejects.toMatchObject(forbidden);
	});

	it.each([
		['auth', undefined],
		['identity', undefined],
		['webpush', undefined],
		['sessions', 'auth_'],
		['models', 'ai_'],
		['queuey', 'queue_'],
		['corex', 'core_x_'],
	])(
		'refuses an extension "%s" (prefix %s) that would reach the host’s tables',
		async (id, tablePrefix) => {
			const clash = defineExtension({
				manifest: {
					id,
					version: '0.0.0',
					sdk: `^${SDK_VERSION}`,
					...(tablePrefix && { tablePrefix }),
				},
			});
			await expect(createTestKernel({ extensions: [clash] })).rejects.toThrow(
				/cannot be installed/,
			);
		},
	);

	it('lets an extension whose name only starts like a reserved one install', async () => {
		const aid = defineExtension({
			manifest: { id: 'aid', version: '0.0.0', sdk: `^${SDK_VERSION}` },
		});
		const k2 = await createTestKernel({ extensions: [aid] });
		await k2.close();
	});

	it('refuses a migration that creates a table outside its prefix', async () => {
		const sloppy = defineTestExtension({
			id: 'sloppy',
			migrations: { '0001': { up: table('everyone_items') } },
		});
		await expect(createTestKernel({ extensions: [sloppy] })).rejects.toMatchObject(forbidden);
	});
});

describe('calls', () => {
	it('runs a called action in the callee’s view of the same transaction', async () => {
		await run('tasks.add', { id: 't1' });
		await expect(run('notes.call', { target: 'tasks.count' })).resolves.toEqual({
			status: 'applied',
			output: 1,
		});
	});

	it('refuses an action the manifest does not call, naming famos.calls', async () => {
		const error = await run('notes.call', { target: 'tasks.private' }).catch((e: unknown) => e);
		expect(error).toMatchObject(forbidden);
		expect(String((error as Error).message)).toContain('famos.calls');
	});

	it('lets an extension’s context invoke its own and its called actions only', async () => {
		const { actions } = k.contextFor('notes');
		await expect(actions.invoke('notes.family', {}, system)).resolves.toMatchObject({
			status: 'applied',
		});
		await expect(actions.invoke('tasks.count', {}, system)).resolves.toMatchObject({
			status: 'applied',
		});
		await expect(actions.invoke('tasks.private', {}, system)).rejects.toMatchObject(forbidden);
		await expect(
			actions.invoke('core.createMember', { displayName: 'X', roleId: 'admin' }, system),
		).rejects.toMatchObject(forbidden);
		// The host reaches every action.
		await expect(k.ctx.actions.invoke('tasks.private', {}, system)).resolves.toMatchObject({
			status: 'applied',
		});
	});

	it('lets an AI actor reach what the AI is offered, and nothing else', async () => {
		const { actions } = k.contextFor('notes');
		await expect(actions.invoke('tasks.forAi', {}, ai)).resolves.toMatchObject({
			status: 'applied',
		});
		await expect(actions.invoke('tasks.private', {}, ai)).rejects.toMatchObject(forbidden);
	});
});

describe('files', () => {
	it('grants a file with the change, and not when it rolls back', async () => {
		const notesFiles = k.contextFor('notes').files;
		const tasksFiles = k.contextFor('tasks').files;
		await notesFiles.put('notes/kept', new TextEncoder().encode('a'), 'text/plain');
		await notesFiles.put('notes/dropped', new TextEncoder().encode('b'), 'text/plain');
		await expect(run('notes.add', { id: 'dropped', text: 'x', fail: true })).rejects.toThrow();
		await run('notes.add', { id: 'kept', text: 'x' });
		expect(await tasksFiles.stat('notes/kept')).toMatchObject({ size: 1 });
		expect(await tasksFiles.stat('notes/dropped')).toBeNull();
		await expect(tasksFiles.delete('notes/kept')).rejects.toMatchObject(forbidden);
		await expect(tasksFiles.grant('notes/kept', 'other')).rejects.toMatchObject(forbidden);
	});
});

describe('contexts', () => {
	it('gives register, jobs and providers their own extension’s context', async () => {
		const own = k.contextFor('notes');
		expect(registered?.db).toBe(own.db);
		await own.enqueue('notes.look', {});
		await k.worker.drain();
		expect(jobCtx?.db).toBe(own.db);
		const { actor } = await k.member('admin');
		if (actor.kind !== 'member') throw new Error('expected a member');
		await k.share(actor.memberId, { channel: 'test', text: 'hi', files: [] });
		expect(shareCtx?.db).toBe(own.db);
	});

	it('gives each extension its own secret box', () => {
		const sealed = k.contextFor('notes').secrets.seal('webcal://example.org/private');
		expect(k.contextFor('notes').secrets.open(sealed)).toBe('webcal://example.org/private');
		expect(k.contextFor('tasks').secrets.open(sealed)).toBeNull();
	});
});
