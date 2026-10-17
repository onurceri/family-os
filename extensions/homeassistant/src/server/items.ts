import { defineAction, defineRoute, FamosError, type UnitOfWork } from '@famos/sdk';
import { z } from 'zod';
import {
	AddItemInputSchema,
	type Item,
	ItemListSchema,
	ItemSchema,
	MAX_ITEMS,
	MoveItemInputSchema,
	operationsOf,
	RemoveItemInputSchema,
	RenameItemInputSchema,
	SetItemControlInputSchema,
} from '../contract/index.ts';
import { homeassistantManage, itemsChanged } from './capabilities.ts';
import { type HomeAssistantTables, tables } from './store.ts';

/**
 * What the family shows from Home Assistant: a few sensors, each with a short name of its own,
 * and for each the family's choice whether it may be switched from FamilyOS. Disconnecting keeps
 * them, so a reconnect to the same Home Assistant finds them again.
 */

type Row = HomeAssistantTables['homeassistant_items'];

/** Only a thing the table can switch can be switched, whatever an old row says. */
export const mayControl = (row: Row): boolean =>
	row.control === 1 && operationsOf(row.entity_id).length > 0;

export const toItem = (row: Row): Item => ({
	id: row.id,
	entityId: row.entity_id as Item['entityId'],
	label: row.label,
	position: row.position,
	control: mayControl(row),
	confirm: row.confirm === 1,
});

export const loadItems = (db: UnitOfWork['db']) =>
	tables(db).selectFrom('homeassistant_items').selectAll().orderBy('position').execute();

/** Gives the rows positions 0, 1, 2 … in the order given. */
async function renumber(uow: UnitOfWork, ids: readonly string[]): Promise<void> {
	const now = uow.clock.now();
	const current = new Map((await loadItems(uow.db)).map((r) => [r.id, r.position]));
	for (const [position, id] of ids.entries()) {
		if (current.get(id) === position) continue;
		await tables(uow.db)
			.updateTable('homeassistant_items')
			.set({ position, updated_at: now })
			.where('id', '=', id)
			.execute();
	}
}

export async function findItem(uow: UnitOfWork, id: string): Promise<Row> {
	const row = await tables(uow.db)
		.selectFrom('homeassistant_items')
		.selectAll()
		.where('id', '=', id)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'That item is not on the list');
	return row;
}

export const addItem = defineAction({
	id: 'homeassistant.addItem',
	title: 'Show a Home Assistant sensor',
	input: AddItemInputSchema,
	output: ItemSchema,
	requires: homeassistantManage.id,
	approval: 'never',
	async run(uow, input) {
		const rows = await loadItems(uow.db);
		if (rows.length >= MAX_ITEMS)
			throw new FamosError('limit_reached', `At most ${MAX_ITEMS} things can be shown`);
		if (rows.some((r) => r.entity_id === input.entityId))
			throw new FamosError('conflict', 'That sensor is already shown');
		const now = uow.clock.now();
		const row: Row = {
			id: uow.ids.next('ha_item'),
			entity_id: input.entityId,
			label: input.label,
			position: rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.position)) + 1,
			// Shown only: switching it is a choice of its own, and so is asking first.
			control: 0,
			confirm: 0,
			created_at: now,
			updated_at: now,
		};
		await tables(uow.db).insertInto('homeassistant_items').values(row).execute();
		uow.emit(itemsChanged, {});
		return toItem(row);
	},
});

export const renameItem = defineAction({
	id: 'homeassistant.renameItem',
	title: 'Rename a Home Assistant sensor shown',
	input: RenameItemInputSchema,
	output: ItemSchema,
	requires: homeassistantManage.id,
	approval: 'never',
	async run(uow, input) {
		const row = await findItem(uow, input.id);
		const updated = { ...row, label: input.label, updated_at: uow.clock.now() };
		await tables(uow.db)
			.updateTable('homeassistant_items')
			.set({ label: updated.label, updated_at: updated.updated_at })
			.where('id', '=', row.id)
			.execute();
		uow.emit(itemsChanged, {});
		return toItem(updated);
	},
});

export const setItemControl = defineAction({
	id: 'homeassistant.setItemControl',
	title: 'Choose whether a Home Assistant item can be switched from FamilyOS',
	input: SetItemControlInputSchema,
	output: ItemSchema,
	requires: homeassistantManage.id,
	approval: 'never',
	// What FamilyOS may switch in the home is a person's decision, never a suggestion.
	refuseProposal: async () => 'Only a person can choose what may be switched from FamilyOS.',
	async run(uow, input) {
		const row = await findItem(uow, input.id);
		if (input.control && operationsOf(row.entity_id).length === 0)
			throw new FamosError('bad_request', 'FamilyOS cannot switch this kind of thing');
		const updated = {
			...row,
			control: input.control ? 1 : 0,
			confirm: input.confirm ? 1 : 0,
			updated_at: uow.clock.now(),
		};
		await tables(uow.db)
			.updateTable('homeassistant_items')
			.set({ control: updated.control, confirm: updated.confirm, updated_at: updated.updated_at })
			.where('id', '=', row.id)
			.execute();
		uow.emit(itemsChanged, {});
		return toItem(updated);
	},
});

export const removeItem = defineAction({
	id: 'homeassistant.removeItem',
	title: 'Stop showing a Home Assistant sensor',
	input: RemoveItemInputSchema,
	output: z.object({ ok: z.literal(true) }),
	requires: homeassistantManage.id,
	approval: 'never',
	async run(uow, input) {
		const row = await findItem(uow, input.id);
		await tables(uow.db).deleteFrom('homeassistant_items').where('id', '=', row.id).execute();
		await renumber(
			uow,
			(await loadItems(uow.db)).map((r) => r.id),
		);
		uow.emit(itemsChanged, {});
		return { ok: true as const };
	},
});

export const moveItem = defineAction({
	id: 'homeassistant.moveItem',
	title: 'Move a Home Assistant sensor in the list',
	input: MoveItemInputSchema,
	output: ItemListSchema,
	requires: homeassistantManage.id,
	approval: 'never',
	async run(uow, input) {
		const row = await findItem(uow, input.id);
		const ids = (await loadItems(uow.db)).map((r) => r.id).filter((id) => id !== row.id);
		ids.splice(Math.min(input.position, ids.length), 0, row.id);
		await renumber(uow, ids);
		uow.emit(itemsChanged, {});
		return { items: (await loadItems(uow.db)).map(toItem) };
	},
});

export const listItems = defineRoute({
	method: 'get',
	path: '/items',
	operationId: 'homeassistant.listItems',
	summary: 'What the family shows from Home Assistant, in order',
	requires: homeassistantManage.id,
	response: ItemListSchema,
	async handle(ctx) {
		return { items: (await loadItems(ctx.db)).map(toItem) };
	},
});
