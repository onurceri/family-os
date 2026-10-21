import type { Actor } from '@famos/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chore } from '../src/contract/index.ts';
import { tables } from '../src/server/store.ts';
import { applied, createKernel, type Person, person } from './support.ts';

let k: Awaited<ReturnType<typeof createKernel>>['k'];
let ayse: Person;
let bora: Person;

beforeEach(async () => {
	({ k } = await createKernel());
	ayse = await person(k, 'admin', 'Ayşe');
	bora = await person(k, 'member', 'Bora');
});
afterEach(() => k.close());

const create = () =>
	applied<Chore>(
		k,
		'chores.createChore',
		{ title: 'Dishes', startDate: '2026-10-06', assigneeIds: [ayse.id, bora.id] },
		ayse.actor,
	);
const versionOf = async (id: string) =>
	(
		await tables(k.ctx.db)
			.selectFrom('chores_chores')
			.select('version')
			.where('id', '=', id)
			.executeTakeFirstOrThrow()
	).version;

describe('chores in the change log', () => {
	it('records a chore, a completion of it, and its archiving as a delete', async () => {
		const chore = await create();
		const seen = await k.changes.head();
		await applied(k, 'chores.markDone', { id: chore.id, dueDate: chore.nextDue }, ayse.actor);
		let page = await k.changes.since(seen, ayse.actor);
		expect(page.changes.map((c) => [c.entity, c.id, c.op])).toEqual([
			['chore', chore.id, 'upsert'],
		]);
		await applied(k, 'chores.archiveChore', { id: chore.id }, ayse.actor);
		page = await k.changes.since(seen, ayse.actor);
		expect(page.changes.map((c) => [c.id, c.op])).toEqual([[chore.id, 'delete']]);
	});

	it('raises the version when the people in turn or the latest completion change', async () => {
		const chore = await create();
		const created = await versionOf(chore.id);
		await applied(k, 'chores.setAssignees', { id: chore.id, memberIds: [bora.id] }, ayse.actor);
		const afterPeople = await versionOf(chore.id);
		expect(afterPeople).toBeGreaterThan(created);
		await applied(k, 'chores.markDone', { id: chore.id, dueDate: chore.nextDue }, bora.actor);
		expect(await versionOf(chore.id)).toBeGreaterThan(afterPeople);
	});
});

describe('the people of a chore in the change log', () => {
	it('tells a reader the chore changed when its people were rewritten, and no one else', async () => {
		const chore = await create();
		const seen = await k.changes.head();
		await applied(k, 'chores.setAssignees', { id: chore.id, memberIds: [bora.id] }, ayse.actor);
		const page = await k.changes.since(seen, ayse.actor);
		expect(page.changes.map((c) => [c.entity, c.id, c.op])).toEqual([
			['chore', chore.id, 'upsert'],
		]);
		const display: Actor = { kind: 'display', deviceId: 'd1', capabilities: [], showNames: false };
		expect((await k.changes.since(seen, display)).changes).toEqual([]);
	});
});
