import {
	type Actor,
	type DuplicateContext,
	defineAction,
	defineCapability,
	defineEvent,
	defineRoute,
	FamosError,
	labelNamesTitle,
	searchFinds,
	type UnitOfWork,
} from '@famos/sdk';
import { sql } from 'kysely';
import { z } from 'zod';
import {
	AddShoppingItemsSchema,
	CATEGORIES,
	CategorySchema,
	ListNameSchema,
	ReviewLabelSchema,
	SHOPPING_QUANTITY_MAX,
	SHOPPING_TITLE_MAX,
	ShoppingItemIdSchema,
	ShoppingItemSchema,
	ShoppingListIdSchema,
	ShoppingListSchema,
	shoppingChangedPayload,
} from '../contract/index.ts';
import { type ItemRow, tables, titleKey, toItem } from './store.ts';
import { listsView } from './tasks.ts';

export const shoppingChanged = defineEvent('lists.shopping.changed', shoppingChangedPayload);

/** What shopping protects: adding and ticking off items, and managing the lists. */
export const shoppingEdit = defineCapability({
	id: 'lists.shopping.edit',
	label: 'lists:cap_shopping_edit',
	level: 'use',
});
export const shoppingManage = defineCapability({
	id: 'lists.shopping.manage',
	label: 'lists:cap_shopping_manage',
	level: 'edit',
});
const memberId = (actor: Actor) => (actor.kind === 'member' ? actor.memberId : null);

/** What the model calls the list that has no name of its own. */
const DEFAULT_LIST_LABEL = 'Shopping list';
/** Names a person or the model may use for that list when asking for it by name. */
const DEFAULT_LIST_ALIASES = [DEFAULT_LIST_LABEL, 'Groceries', 'Market'];

/** The names a list answers to: its own, or the aliases of the list that has none. */
export const namesOf = (list: { name: string }) => (list.name ? [list.name] : DEFAULT_LIST_ALIASES);

async function activeList(uow: UnitOfWork, id: string | undefined) {
	let query = tables(uow.db)
		.selectFrom('lists_shopping_lists')
		.selectAll()
		.where('archived_at', 'is', null);
	query = id ? query.where('id', '=', id) : query.orderBy('sort').orderBy('created_at');
	const list = await query.executeTakeFirst();
	if (!list)
		throw new FamosError(
			id ? 'not_found' : 'conflict',
			id ? 'List not found' : 'There is no shopping list',
		);
	return list;
}

/** The title of a listed item, for the runner's check that an AI's label names the right one. */
const itemTitle = async (ctx: DuplicateContext, { id }: { id: string }) =>
	(
		await tables(ctx.db)
			.selectFrom('lists_shopping_items')
			.select('title')
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst()
	)?.title ?? null;

/**
 * The member who added every one of these items, or null when someone else added any of them (or
 * one is no longer on a list): taking back what you added yourself needs nobody's approval.
 */
async function addedByOne(ctx: DuplicateContext, ids: readonly string[]): Promise<string | null> {
	const wanted = [...new Set(ids)];
	if (wanted.length === 0) return null;
	const rows = await tables(ctx.db)
		.selectFrom('lists_shopping_items')
		.select('added_by')
		.where('id', 'in', wanted)
		.where('deleted_at', 'is', null)
		.execute();
	const by = new Set(rows.map((r) => r.added_by));
	if (rows.length !== wanted.length || by.size !== 1) return null;
	return [...by][0] ?? null;
}

async function loadItem(uow: UnitOfWork, id: string) {
	const row = await tables(uow.db)
		.selectFrom('lists_shopping_items')
		.selectAll()
		.where('id', '=', id)
		.where('deleted_at', 'is', null)
		.executeTakeFirst();
	if (!row) throw new FamosError('not_found', 'Item not found');
	return row;
}

/** What an item looked like before an add merged into it, so Undo can put it back. */
const MergedItemSchema = z.object({
	id: z.string(),
	quantity: z.string().nullable(),
	category: CategorySchema,
	doneAt: z.number().nullable(),
	doneBy: z.string().nullable(),
});

export const addShoppingItems = defineAction({
	id: 'lists.addShoppingItems',
	offline: true,
	title: 'Add items to a shopping list',
	draftTitle: 'lists:draft_title_add_shopping_items',
	requires: shoppingEdit.id,
	autoApprove: {
		label: 'lists:auto_approve_shopping',
		capabilities: [shoppingManage.id, shoppingEdit.id],
	},
	description:
		'Items already on the list are not duplicated (a new quantity replaces the old one; an empty one keeps it); bought items come back. Without a category, the one last used for the product is reused.',
	input: AddShoppingItemsSchema,
	output: z.object({
		listId: z.string(),
		items: z.array(ShoppingItemSchema),
		/** Items this call created (others were already on the list and only updated). */
		addedIds: z.array(z.string()),
		/** Items that were already there and changed by this call, as they were before. */
		merged: z.array(MergedItemSchema).default([]),
	}),
	// Undo removes what was added and puts merged items back as they were.
	undo: (output) =>
		output.addedIds.length || output.merged.length
			? {
					actionId: 'lists.undoAddShoppingItems',
					input: { addedIds: output.addedIds, merged: output.merged },
				}
			: null,
	// A list named in words ("Hardware store") becomes its id here, before the proposal is judged
	// and stored, so a draft always points at one real list; an unknown name is refused with the
	// real names, which also stops a model from inventing one.
	async resolveNames(ctx, input) {
		if (input.list === undefined) return input;
		const { list, ...rest } = input;
		if (rest.listId || list === '') return rest;
		const { locale } = await ctx.family.settings();
		const lists = await tables(ctx.db)
			.selectFrom('lists_shopping_lists')
			.select(['id', 'name'])
			.where('archived_at', 'is', null)
			.orderBy('sort')
			.orderBy('created_at')
			.execute();
		const wanted = titleKey(list, locale);
		const found = lists.find((l) => namesOf(l).some((n) => titleKey(n, locale) === wanted));
		if (!found)
			throw new FamosError(
				'bad_request',
				`There is no list called '${list}'. The lists are: ${lists.map((l) => l.name || DEFAULT_LIST_LABEL).join(', ')}. Use one of these names, or omit the list for the default one.`,
			);
		return { ...rest, listId: ShoppingListIdSchema.parse(found.id) };
	},
	// Every item is already on a list and not bought yet (or only some are).
	async alreadyThere(ctx, input) {
		const { locale } = await ctx.family.settings();
		const keys = input.items.map((item) => titleKey(item.title, locale));
		const open = await tables(ctx.db)
			.selectFrom('lists_shopping_items')
			.select('title_key')
			.where('title_key', 'in', keys)
			.where('done_at', 'is', null)
			.where('deleted_at', 'is', null)
			.execute();
		const found = new Set(open.map((row) => row.title_key));
		if (keys.every((key) => found.has(key))) return true;
		return keys.some((key) => found.has(key)) ? 'some' : false;
	},
	ai: {
		description:
			'Adds things to buy to a family shopping list (groceries, household supplies, things someone needs for school).',
		guidance:
			'Only things the family must buy, not things to bring that a family usually already has (use a task for those). One item per product, titled in the family language with a capital first letter like a list entry ("Milk", not "milk"; brand names as written). The amount goes in quantity, never in the title: "2 litres of milk" is title "Milk", quantity "2 litres"; keep every amount the item gives, with its unit, as written ("2 kg", "1 pack", "a dozen"). A word that describes the product is not an amount: "a new football" is title "Football" with no quantity. Pick the store section as category when obvious. When the person names a list, send the name as they said it in `list` (an unknown name is refused with the real names), or its id from lists.shoppingList as listId; when no list is named, omit both and the default list is used.',
	},
	async run(uow, input) {
		const list = await activeList(uow, input.listId);
		const { locale } = await uow.family.settings();
		const db = tables(uow.db);
		const now = uow.clock.now();
		const out: ItemRow[] = [];
		const addedIds: string[] = [];
		const merged: z.infer<typeof MergedItemSchema>[] = [];
		for (const item of input.items) {
			const key = titleKey(item.title, locale);
			const existing = await db
				.selectFrom('lists_shopping_items')
				.selectAll()
				.where('list_id', '=', list.id)
				.where('title_key', '=', key)
				.where('deleted_at', 'is', null)
				.orderBy(sql`done_at is not null`)
				.orderBy('updated_at', 'desc')
				.executeTakeFirst();
			if (existing && existing.done_at === null && input.whenOnList === 'keep') {
				out.push(existing);
				continue;
			}
			if (existing) {
				if (!merged.some((m) => m.id === existing.id))
					merged.push({
						id: existing.id,
						quantity: existing.quantity,
						category: existing.category as z.infer<typeof CategorySchema>,
						doneAt: existing.done_at,
						doneBy: existing.done_by,
					});
				const patch = {
					done_at: null,
					done_by: null,
					// An add without an amount never clears the one on the list (an editor sends null for
					// an empty field); clearing it is `lists.updateShoppingItem`.
					quantity: item.quantity || existing.quantity,
					category: item.category ?? existing.category,
					updated_at: now,
				};
				await db
					.updateTable('lists_shopping_items')
					.set(patch)
					.where('id', '=', existing.id)
					.execute();
				out.push({ ...existing, ...patch });
				continue;
			}
			const remembered = item.category
				? undefined
				: await db
						.selectFrom('lists_shopping_items')
						.select('category')
						.where('title_key', '=', key)
						.where('category', '!=', 'other')
						.orderBy('updated_at', 'desc')
						.executeTakeFirst();
			const row: ItemRow = {
				id: uow.ids.next('shop_item'),
				list_id: list.id,
				title: item.title,
				title_key: key,
				quantity: item.quantity ?? null,
				category: item.category ?? remembered?.category ?? 'other',
				done_at: null,
				done_by: null,
				added_by: memberId(uow.actor),
				source_kind: null,
				source_id: null,
				created_at: now,
				updated_at: now,
				deleted_at: null,
			};
			await db.insertInto('lists_shopping_items').values(row).execute();
			out.push(row);
			addedIds.push(row.id);
		}
		uow.emit(shoppingChanged, { listId: list.id });
		return { listId: list.id, items: out.map(toItem), addedIds, merged };
	},
});

/** Takes back an add: new items go, merged items return to what they were. */
export const undoAddShoppingItems = defineAction({
	id: 'lists.undoAddShoppingItems',
	title: 'Take back added shopping items',
	draftTitle: 'lists:draft_title_undo_add_shopping_items',
	requires: shoppingEdit.id,
	approval: {
		unless: shoppingManage.id,
		owner: (ctx, { addedIds, merged }) =>
			addedByOne(ctx, [...addedIds, ...merged.map((m) => m.id)]),
	},
	input: z.object({
		addedIds: z.array(ShoppingItemIdSchema).max(100),
		merged: z.array(MergedItemSchema).max(100),
	}),
	output: z.object({ removed: z.number().int(), restored: z.number().int() }),
	async run(uow, { addedIds, merged }) {
		const db = tables(uow.db);
		const now = uow.clock.now();
		const lists = new Set<string>();
		let removed = 0;
		if (addedIds.length) {
			const rows = await db
				.selectFrom('lists_shopping_items')
				.select('list_id')
				.where('id', 'in', addedIds)
				.where('deleted_at', 'is', null)
				.execute();
			for (const r of rows) lists.add(r.list_id);
			const result = await db
				.updateTable('lists_shopping_items')
				.set({ deleted_at: now, updated_at: now })
				.where('id', 'in', addedIds)
				.where('deleted_at', 'is', null)
				.executeTakeFirst();
			removed = Number(result.numUpdatedRows);
		}
		let restored = 0;
		for (const item of merged) {
			const result = await db
				.updateTable('lists_shopping_items')
				.set({
					quantity: item.quantity,
					category: item.category,
					done_at: item.doneAt,
					done_by: item.doneBy,
					updated_at: now,
				})
				.where('id', '=', item.id)
				.where('deleted_at', 'is', null)
				.returningAll()
				.executeTakeFirst();
			if (result) {
				restored += 1;
				lists.add(result.list_id);
			}
		}
		for (const listId of lists) uow.emit(shoppingChanged, { listId });
		return { removed, restored };
	},
});

export const updateShoppingItem = defineAction({
	id: 'lists.updateShoppingItem',
	title: 'Change a shopping item',
	requires: shoppingEdit.id,
	input: z.object({
		id: ShoppingItemIdSchema,
		title: z.string().trim().min(1).max(SHOPPING_TITLE_MAX).optional(),
		quantity: z.string().trim().max(SHOPPING_QUANTITY_MAX).nullable().optional(),
		category: CategorySchema.optional(),
	}),
	output: ShoppingItemSchema,
	async run(uow, { id, title, quantity, category }) {
		const row = await loadItem(uow, id);
		const { locale } = await uow.family.settings();
		const patch = {
			...(title !== undefined && { title, title_key: titleKey(title, locale) }),
			...(quantity !== undefined && { quantity }),
			...(category !== undefined && { category }),
			updated_at: uow.clock.now(),
		};
		await tables(uow.db)
			.updateTable('lists_shopping_items')
			.set(patch)
			.where('id', '=', id)
			.execute();
		uow.emit(shoppingChanged, { listId: row.list_id });
		return toItem({ ...row, ...patch });
	},
});

export const checkShoppingItem = defineAction({
	id: 'lists.checkShoppingItem',
	targetTitle: itemTitle,
	offline: true,
	title: 'Tick off (or untick) a shopping item',
	draftTitle: 'lists:draft_title_check_shopping_item',
	requires: shoppingEdit.id,
	input: z.object({ id: ShoppingItemIdSchema, done: z.boolean(), label: ReviewLabelSchema }),
	output: ShoppingItemSchema,
	refuseProposal: async (ctx, { id, done }) => {
		const row = await tables(ctx.db)
			.selectFrom('lists_shopping_items')
			.select(['title', 'done_at'])
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		if (!row || (row.done_at !== null) !== done) return null;
		return done
			? `${row.title} is already ticked off.`
			: `${row.title} is already on the list, not ticked off.`;
	},
	// Already ticked (or already unticked) by someone: approving would change nothing, and its
	// undo would reverse what that person really did.
	async settled(ctx, { id, done }) {
		const row = await tables(ctx.db)
			.selectFrom('lists_shopping_items')
			.select('done_at')
			.where('id', '=', id)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		return row !== undefined && (row.done_at !== null) === done;
	},
	undo: (item) => ({
		actionId: 'lists.checkShoppingItem',
		input: { id: item.id, done: item.doneAt === null },
	}),
	ai: {
		description:
			'Ticks off a shopping item as bought (done true), or puts it back on the list (done false). Find it with lists.shoppingList first.',
	},
	async run(uow, { id, done }) {
		const row = await loadItem(uow, id);
		if ((row.done_at !== null) === done) return toItem(row);
		const now = uow.clock.now();
		const patch = done
			? { done_at: now, done_by: memberId(uow.actor), updated_at: now }
			: { done_at: null, done_by: null, updated_at: now };
		await tables(uow.db)
			.updateTable('lists_shopping_items')
			.set(patch)
			.where('id', '=', id)
			.execute();
		uow.emit(shoppingChanged, { listId: row.list_id });
		return toItem({ ...row, ...patch });
	},
});

export const deleteShoppingItem = defineAction({
	id: 'lists.deleteShoppingItem',
	targetTitle: itemTitle,
	title: 'Remove a shopping item',
	draftTitle: 'lists:draft_title_delete_shopping_item',
	requires: shoppingEdit.id,
	input: z.object({ id: ShoppingItemIdSchema, label: ReviewLabelSchema }),
	output: z.object({ ok: z.literal(true), id: z.string() }),
	approval: { unless: shoppingManage.id, owner: (ctx, { id }) => addedByOne(ctx, [id]) },
	undo: ({ id }) => ({ actionId: 'lists.restoreShoppingItem', input: { id } }),
	ai: {
		description:
			'Removes an item from a shopping list (not bought, just no longer needed). Find it with lists.shoppingList first; to mark it bought use lists.checkShoppingItem.',
	},
	async run(uow, { id }) {
		const row = await loadItem(uow, id);
		const now = uow.clock.now();
		await tables(uow.db)
			.updateTable('lists_shopping_items')
			.set({ deleted_at: now, updated_at: now })
			.where('id', '=', id)
			.execute();
		uow.emit(shoppingChanged, { listId: row.list_id });
		return { ok: true as const, id };
	},
});

/** Takes back the removal of a shopping item. */
export const restoreShoppingItem = defineAction({
	id: 'lists.restoreShoppingItem',
	title: 'Put a removed shopping item back',
	requires: shoppingEdit.id,
	input: z.object({ id: ShoppingItemIdSchema }),
	output: ShoppingItemSchema,
	async run(uow, { id }) {
		const row = await tables(uow.db)
			.selectFrom('lists_shopping_items')
			.selectAll()
			.where('id', '=', id)
			.executeTakeFirst();
		if (!row) throw new FamosError('not_found', 'Item not found');
		const patch = { deleted_at: null, updated_at: uow.clock.now() };
		await tables(uow.db)
			.updateTable('lists_shopping_items')
			.set(patch)
			.where('id', '=', id)
			.execute();
		uow.emit(shoppingChanged, { listId: row.list_id });
		return toItem({ ...row, ...patch });
	},
});

export const removeShoppingItems = defineAction({
	id: 'lists.removeShoppingItems',
	title: 'Remove several shopping items',
	draftTitle: 'lists:draft_title_remove_shopping_items',
	requires: shoppingEdit.id,
	input: z.object({ ids: z.array(ShoppingItemIdSchema).min(1).max(50) }),
	output: z.object({ removed: z.number().int(), ids: z.array(z.string()) }),
	approval: { unless: shoppingManage.id, owner: (ctx, { ids }) => addedByOne(ctx, ids) },
	undo: ({ ids }) =>
		ids.length ? { actionId: 'lists.restoreShoppingItems', input: { ids } } : null,
	ai: {
		description:
			'Removes several items from the shopping lists at once (not bought, just no longer needed). Find them with lists.shoppingList first and send all their ids in one call.',
	},
	async run(uow, { ids }) {
		const now = uow.clock.now();
		const db = tables(uow.db);
		const rows = await db
			.selectFrom('lists_shopping_items')
			.select(['id', 'list_id'])
			.where('id', 'in', ids)
			.where('deleted_at', 'is', null)
			.execute();
		const result = await db
			.updateTable('lists_shopping_items')
			.set({ deleted_at: now, updated_at: now })
			.where('id', 'in', ids)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		for (const listId of new Set(rows.map((r) => r.list_id))) uow.emit(shoppingChanged, { listId });
		return { removed: Number(result.numUpdatedRows), ids: rows.map((r) => r.id) };
	},
});

/** Takes back `lists.removeShoppingItems`. */
export const restoreShoppingItems = defineAction({
	id: 'lists.restoreShoppingItems',
	title: 'Put removed shopping items back',
	requires: shoppingEdit.id,
	input: z.object({ ids: z.array(ShoppingItemIdSchema).min(1).max(50) }),
	output: z.object({ restored: z.number().int() }),
	async run(uow, { ids }) {
		const db = tables(uow.db);
		const rows = await db
			.selectFrom('lists_shopping_items')
			.select('list_id')
			.where('id', 'in', ids)
			.execute();
		const result = await db
			.updateTable('lists_shopping_items')
			.set({ deleted_at: null, updated_at: uow.clock.now() })
			.where('id', 'in', ids)
			.executeTakeFirst();
		for (const listId of new Set(rows.map((r) => r.list_id))) uow.emit(shoppingChanged, { listId });
		return { restored: Number(result.numUpdatedRows) };
	},
});

export const clearBought = defineAction({
	id: 'lists.clearBought',
	title: 'Clear the bought items of a list',
	draftTitle: 'lists:draft_title_clear_bought',
	requires: shoppingEdit.id,
	input: z.object({ listId: ShoppingListIdSchema }),
	output: z.object({ cleared: z.number().int() }),
	approval: { unless: shoppingManage.id },
	async run(uow, { listId }) {
		const list = await activeList(uow, listId);
		const now = uow.clock.now();
		const result = await tables(uow.db)
			.updateTable('lists_shopping_items')
			.set({ deleted_at: now, updated_at: now })
			.where('list_id', '=', list.id)
			.where('done_at', 'is not', null)
			.where('deleted_at', 'is', null)
			.executeTakeFirst();
		uow.emit(shoppingChanged, { listId: list.id });
		return { cleared: Number(result.numUpdatedRows) };
	},
});

/** Two lists may not share a name (case and spacing ignored): the chips would be ambiguous. */
async function assertNameFree(uow: UnitOfWork, name: string, except?: string) {
	const rows = await tables(uow.db)
		.selectFrom('lists_shopping_lists')
		.select(['id', 'name'])
		.where('archived_at', 'is', null)
		.execute();
	const key = (n: string) => n.trim().toLocaleLowerCase();
	if (rows.some((r) => r.id !== except && key(r.name) === key(name)))
		throw new FamosError('conflict', 'A list with this name already exists', {
			reason: 'name_taken',
		});
}

export const createShoppingList = defineAction({
	id: 'lists.createShoppingList',
	title: 'Create a shopping list',
	draftTitle: 'lists:draft_title_create_shopping_list',
	input: z.object({ name: ListNameSchema }),
	output: ShoppingListSchema,
	approval: { unless: shoppingManage.id },
	async run(uow, { name }) {
		await assertNameFree(uow, name);
		const db = tables(uow.db);
		const last = await db
			.selectFrom('lists_shopping_lists')
			.select((eb) => eb.fn.max('sort').as('sort'))
			.executeTakeFirst();
		const now = uow.clock.now();
		const id = uow.ids.next('shop_list');
		await db
			.insertInto('lists_shopping_lists')
			.values({
				id,
				name,
				sort: Number(last?.sort ?? 0) + 1,
				created_at: now,
				updated_at: now,
				archived_at: null,
			})
			.execute();
		uow.emit(shoppingChanged, { listId: id });
		return { id, name, openCount: 0 };
	},
});

export const renameShoppingList = defineAction({
	id: 'lists.renameShoppingList',
	title: 'Rename a shopping list',
	draftTitle: 'lists:draft_title_rename_shopping_list',
	input: z.object({ id: ShoppingListIdSchema, name: ListNameSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: shoppingManage.id },
	async run(uow, { id, name }) {
		await activeList(uow, id);
		await assertNameFree(uow, name, id);
		await tables(uow.db)
			.updateTable('lists_shopping_lists')
			.set({ name, updated_at: uow.clock.now() })
			.where('id', '=', id)
			.execute();
		uow.emit(shoppingChanged, { listId: id });
		return { ok: true as const };
	},
});

export const archiveShoppingList = defineAction({
	id: 'lists.archiveShoppingList',
	title: 'Remove a shopping list',
	draftTitle: 'lists:draft_title_archive_shopping_list',
	input: z.object({ id: ShoppingListIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	approval: { unless: shoppingManage.id },
	async run(uow, { id }) {
		await activeList(uow, id);
		const db = tables(uow.db);
		const active = await db
			.selectFrom('lists_shopping_lists')
			.select('id')
			.where('archived_at', 'is', null)
			.execute();
		if (active.length <= 1)
			throw new FamosError('conflict', 'The last shopping list cannot be removed');
		const now = uow.clock.now();
		await db
			.updateTable('lists_shopping_lists')
			.set({ archived_at: now, updated_at: now })
			.where('id', '=', id)
			.execute();
		uow.emit(shoppingChanged, { listId: id });
		return { ok: true as const };
	},
});

const MAX_SHOPPING = 100;

export const shoppingList = defineAction({
	id: 'lists.shoppingList',
	title: 'Shopping lists with what is still to buy, for the AI',
	input: z.object({
		list: z.string().trim().max(60).optional().describe('Only the list with this name'),
		listId: ShoppingListIdSchema.optional().describe('Only this list'),
		text: z
			.string()
			.trim()
			.max(80)
			.optional()
			.describe(
				'Only items whose title shares its words with this text (for example "cheddar" finds "Cheddar cheese"); use it to find one item in a long list',
			),
	}),
	output: z.object({
		truncated: z
			.boolean()
			.optional()
			.describe('True when more items matched than are shown; pass `text` or `list` to see them'),
		note: z.string().optional(),
		lists: z.array(
			z.object({
				id: z.string().describe('The list, for adding items to it (listId)'),
				name: z.string(),
				items: z.array(
					z.object({
						id: z.string().describe('For checking off, changing or removing the item'),
						title: z.string(),
						quantity: z.string().nullable(),
						category: CategorySchema,
						bought: z
							.boolean()
							.describe('True when it was ticked off in the last 7 days; it is not to buy now'),
					}),
				),
			}),
		),
	}),
	readOnly: true,
	requires: listsView.id,
	ai: {
		description:
			'Shows the family shopping lists (each with its id, the way to name a list when adding items): what is still to buy (in store-section order), then what was bought in the last 7 days (bought true). Use it for "is there milk on the list / what do we need" questions. To find one item, pass `text` (lists can be long). An item that is bought is not to buy now; match the name the person used to a listed title by its words, and if none fits, say it is not on the list.',
	},
	async run(uow, { list, listId, text }) {
		const { locale } = await uow.family.settings();
		const wanted = list ? titleKey(list, locale) : null;
		const lists = await tables(uow.db)
			.selectFrom('lists_shopping_lists')
			.selectAll()
			.where('archived_at', 'is', null)
			.orderBy('sort')
			.orderBy('created_at')
			.execute();
		const chosen = lists.filter(
			(l) =>
				(!listId || l.id === listId) &&
				(!wanted || namesOf(l).some((n) => titleKey(n, locale) === wanted)),
		);
		// A name that is no list is said to be one, with the real names: an empty answer would
		// read as "nothing on the list".
		if (wanted && chosen.length === 0 && !listId)
			throw new FamosError(
				'bad_request',
				`There is no list called '${list}'. The lists are: ${lists.map((l) => l.name || DEFAULT_LIST_LABEL).join(', ')}. Use one of these names, or leave the list out for all lists.`,
			);
		const matches = (r: ItemRow) =>
			!text || labelNamesTitle(text, r.title) || searchFinds(text, r.title);
		const boughtSince = uow.clock.now() - BOUGHT_VISIBLE_MS;
		const first = await collect(chosen);
		// An item looked for on a named list that is on another one instead is shown there: "the
		// shopping list" in the person's words may be any of the lists.
		const narrowed = Boolean(text) && chosen.length < lists.length;
		if (narrowed && first.out.every((l) => l.items.length === 0)) {
			const wider = await collect(lists);
			if (wider.out.some((l) => l.items.length > 0))
				return {
					...(wider.truncated && { truncated: true }),
					note: 'Not on the list asked for; these are on the other lists.',
					lists: wider.out.filter((l) => l.items.length > 0),
				};
		}
		return { ...(first.truncated && { truncated: true }), lists: first.out };

		async function collect(chosen: typeof lists) {
			let budget = MAX_SHOPPING;
			let truncated = false;
			const out = [];
			for (const l of chosen) {
				const all = await tables(uow.db)
					.selectFrom('lists_shopping_items')
					.selectAll()
					.where('list_id', '=', l.id)
					.where('deleted_at', 'is', null)
					.where((eb) => eb.or([eb('done_at', 'is', null), eb('done_at', '>=', boughtSince)]))
					.orderBy('created_at')
					.execute();
				// What was just bought stays findable, so a name that matches it is not mapped to
				// another row.
				const open = all.filter((r) => r.done_at === null && matches(r));
				const bought = all
					.filter((r) => r.done_at !== null && matches(r))
					.sort((a, b) => (b.done_at as number) - (a.done_at as number));
				const shownOpen = open.slice(0, budget);
				budget -= shownOpen.length;
				const shownBought = bought.slice(0, budget);
				budget -= shownBought.length;
				if (shownOpen.length < open.length || shownBought.length < bought.length) truncated = true;
				const rank = (r: ItemRow) => CATEGORIES.indexOf(r.category);
				const view = (r: ItemRow, isBought: boolean) => ({
					id: r.id,
					title: r.title,
					quantity: r.quantity,
					category: r.category,
					bought: isBought,
				});
				out.push({
					id: l.id,
					name: l.name || DEFAULT_LIST_LABEL,
					items: [
						...shownOpen.sort((a, b) => rank(a) - rank(b)).map((r) => view(r, false)),
						...shownBought.map((r) => view(r, true)),
					],
				});
			}
			return { truncated, out };
		}
	},
});

export const listShoppingLists = defineRoute({
	method: 'get',
	path: '/shopping/lists',
	operationId: 'lists.listShoppingLists',
	summary: 'Shopping lists with their number of items still to buy',
	requires: listsView.id,
	response: z.array(ShoppingListSchema),
	async handle(ctx) {
		const rows = await tables(ctx.db)
			.selectFrom('lists_shopping_lists as l')
			.leftJoin('lists_shopping_items as i', (join) =>
				join
					.onRef('i.list_id', '=', 'l.id')
					.on('i.done_at', 'is', null)
					.on('i.deleted_at', 'is', null),
			)
			.select(['l.id', 'l.name', (eb) => eb.fn.count<number>('i.id').as('openCount')])
			.where('l.archived_at', 'is', null)
			.groupBy('l.id')
			.orderBy('l.sort')
			.orderBy('l.created_at')
			.execute();
		return rows.map((r) => ({ id: r.id, name: r.name, openCount: Number(r.openCount) }));
	},
});

/** Bought items stay visible for a week (or until cleared). */
export const BOUGHT_VISIBLE_MS = 7 * 86_400_000;

export const listShoppingItems = defineRoute({
	method: 'get',
	path: '/shopping/lists/{listId}/items',
	operationId: 'lists.listShoppingItems',
	summary: 'Items to buy (in store-section order), then recently bought items',
	requires: listsView.id,
	params: z.object({ listId: ShoppingListIdSchema }),
	response: z.array(ShoppingItemSchema),
	async handle(ctx, { params }) {
		const since = ctx.clock.now() - BOUGHT_VISIBLE_MS;
		const rows = await tables(ctx.db)
			.selectFrom('lists_shopping_items')
			.selectAll()
			.where('list_id', '=', params.listId)
			.where('deleted_at', 'is', null)
			.where((eb) => eb.or([eb('done_at', 'is', null), eb('done_at', '>=', since)]))
			.execute();
		const order = (r: ItemRow) => CATEGORIES.indexOf(r.category);
		const open = rows
			.filter((r) => r.done_at === null)
			.sort((a, b) => order(a) - order(b) || a.created_at - b.created_at);
		const bought = rows
			.filter((r) => r.done_at !== null)
			.sort((a, b) => (b.done_at as number) - (a.done_at as number));
		return [...open, ...bought].map(toItem);
	},
});
