import { type DbExecutor, defineEvent, FamosError, selfOf, type UnitOfWork } from '@famos/sdk';
import { type Chore, choreChangedPayload } from '../contract/index.ts';
import { type ChoreRow, parseRecurrence, tables } from './store.ts';

/** Anything in chores changed (a chore, a completion): the UI reloads. */
export const choresChanged = defineEvent('chores.changed', choreChangedPayload, {
	audience: 'chores.view',
	changes: ({ choreId, op }) =>
		choreId ? [{ entity: 'chore', id: choreId, op: op ?? 'upsert' }] : [],
});

export const memberIdOf = selfOf;

export async function assertMembers(uow: UnitOfWork, ids: readonly string[]) {
	if (ids.length === 0) return;
	const active = new Set((await uow.family.members()).map((m) => m.id));
	const unknown = ids.find((id) => !active.has(id));
	if (unknown) throw new FamosError('bad_request', `Unknown member: ${unknown}`);
}

export async function loadChore(db: DbExecutor, id: string): Promise<ChoreRow> {
	const row = await tables(db)
		.selectFrom('chores_chores')
		.selectAll()
		.where('id', '=', id)
		.where('archived_at', 'is', null)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Chore not found');
	return row;
}

/** The chores as people see them: assignees in rotation order and who did it last. */
export async function choreViews(
	db: DbExecutor,
	rows: readonly ChoreRow[],
	today: string,
): Promise<Chore[]> {
	if (rows.length === 0) return [];
	const t = tables(db);
	const ids = rows.map((r) => r.id);
	const [people, done] = await Promise.all([
		t
			.selectFrom('chores_assignees')
			.select(['chore_id', 'member_id', 'position'])
			.where('chore_id', 'in', ids)
			.orderBy('position')
			.execute(),
		t
			.selectFrom('chores_completions')
			.select(['id', 'chore_id', 'member_id', 'done_at'])
			.where('chore_id', 'in', ids)
			.where('undone_at', 'is', null)
			.orderBy('done_at', 'desc')
			.orderBy('id', 'desc')
			.execute(),
	]);
	const order = new Map<string, string[]>();
	for (const p of people) order.set(p.chore_id, [...(order.get(p.chore_id) ?? []), p.member_id]);
	const last = new Map<string, { id: string; memberId: string; doneAt: number }>();
	for (const d of done)
		if (!last.has(d.chore_id))
			last.set(d.chore_id, { id: d.id, memberId: d.member_id, doneAt: d.done_at });
	return rows.map((row) => ({
		id: row.id as Chore['id'],
		title: row.title,
		notes: row.notes,
		recurrence: parseRecurrence(row),
		startDate: row.start_date,
		nextDue: row.next_due,
		overdue: row.next_due !== null && row.next_due < today,
		rotation: row.rotation,
		assigneeId: row.assignee_id,
		assigneeIds: order.get(row.id) ?? [],
		lastDone: last.get(row.id) ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}));
}

export async function choreView(db: DbExecutor, row: ChoreRow, today: string): Promise<Chore> {
	return (await choreViews(db, [row], today))[0] as Chore;
}
