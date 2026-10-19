import {
	type Actor,
	defineAction,
	defineCapability,
	isFamosError,
	type MemberId,
} from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestKernel, defineTestExtension, type TestKernel } from './harness.ts';

// A suggestion about something that is not there is refused like the direct run, not drafted.
const shelfUse = defineCapability({ id: 'shelf.use', label: 'shelf:cap_use', level: 'use' });
const shelfManage = defineCapability({
	id: 'shelf.manage',
	label: 'shelf:cap_manage',
	level: 'edit',
});

type ShelfTables = {
	shelf_things: { id: string; name: string; archived_at: number | null };
};

const shelf = defineTestExtension({
	id: 'shelf',
	capabilities: [shelfUse, shelfManage],
	migrations: {
		'0001_things': {
			up: (db) =>
				db.schema
					.createTable('shelf_things')
					.addColumn('id', 'text', (c) => c.primaryKey())
					.addColumn('name', 'text', (c) => c.notNull())
					.addColumn('archived_at', 'integer')
					.execute(),
		},
	},
	actions: [
		defineAction({
			id: 'shelf.archive',
			title: 'Archive a thing',
			draftTitle: 'shelf:draft_title_archive',
			target: ({ id }) => ({ table: 'shelf_things', id, liveColumn: 'archived_at' }),
			input: z.object({ id: z.string().min(1) }),
			output: z.object({ ok: z.boolean() }),
			requires: shelfUse.id,
			approval: { unless: shelfManage.id },
			async run(uow, { id }) {
				await uow.db
					.withTables<ShelfTables>()
					.updateTable('shelf_things')
					.set({ archived_at: 1 })
					.where('id', '=', id)
					.execute();
				return { ok: true };
			},
		}),
		defineAction({
			id: 'shelf.drop',
			title: 'Drop a thing',
			draftTitle: 'shelf:draft_title_drop',
			target: ({ id }) => ({ table: 'shelf_things', id }),
			input: z.object({ id: z.string().min(1) }),
			output: z.object({ ok: z.boolean() }),
			requires: shelfUse.id,
			approval: { unless: shelfManage.id },
			async run(uow, { id }) {
				await uow.db
					.withTables<ShelfTables>()
					.deleteFrom('shelf_things')
					.where('id', '=', id)
					.execute();
				return { ok: true };
			},
		}),
	],
});

type Who = Awaited<ReturnType<TestKernel['member']>>;
let k: TestKernel;
let admin: Who;
let kid: Who;
beforeEach(async () => {
	k = await createTestKernel({ extensions: [shelf] });
	admin = await k.member('admin');
	kid = await k.member('supervised');
	await k.ctx.db
		.withTables<{ shelf_things: ShelfTables['shelf_things'] }>()
		.insertInto('shelf_things')
		.values([
			{ id: 'live', name: 'Lamp', archived_at: null },
			{ id: 'old', name: 'Vase', archived_at: 5 },
		])
		.execute();
});
afterEach(() => k.close());

const code = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		if (isFamosError(error)) return error.code;
		throw error;
	}
	return 'ok';
};
const drafts = () =>
	k.ctx.db
		.withTables<import('../src/tables.ts').CoreTables>()
		.selectFrom('core_drafts')
		.select('id')
		.execute();
const aiFor = (who: Who): Actor => ({
	kind: 'ai',
	mode: 'agent',
	source: 'mcp',
	onBehalfOf: who.member.id as MemberId,
	roleId: who.actor.roleId,
});

describe('a suggestion whose target is not there', () => {
	it('is drafted for a live target', async () => {
		const result = await k.runner.invoke('shelf.archive', { id: 'live' }, kid.actor);
		expect(result.status).toBe('drafted');
	});

	it('is refused not_found for an id that never existed, for a person and for an AI', async () => {
		expect(await code(k.runner.invoke('shelf.archive', { id: 'ghost' }, kid.actor))).toBe(
			'not_found',
		);
		expect(await code(k.runner.invoke('shelf.drop', { id: 'ghost' }, aiFor(kid)))).toBe(
			'not_found',
		);
		expect(await drafts()).toEqual([]);
	});

	it('is refused when the row is no longer live', async () => {
		expect(await code(k.runner.invoke('shelf.archive', { id: 'old' }, kid.actor))).toBe(
			'not_found',
		);
		expect(await drafts()).toEqual([]);
	});

	it('does not change what a direct run does', async () => {
		expect(await code(k.runner.invoke('shelf.drop', { id: 'live' }, admin.actor))).toBe('ok');
	});
});
