import { AiContextSchema, defineAction } from '@famos/sdk';
import { z } from 'zod';
import { DEFAULT_LIST_LABEL, tables } from './store.ts';
import { listsView } from './tasks.ts';

/**
 * The most open items given to the Inbox, newest first. It is more than a prompt holds: the Inbox
 * puts the ones a shared text names first and keeps only the first few, so an old item that is
 * named is still found on a long list.
 */
const MAX_CONTEXT_ITEMS = 200;
const MAX_CONTEXT_TASKS = 200;

/**
 * The shopping items still to buy, for the AI: a shared message that says "got the light bulbs"
 * can only tick one off when it knows what is on the lists. Only open items, with the list they
 * are on, so the model can tell two lists' items apart.
 */
export const aiContext = defineAction({
	id: 'lists.aiContext',
	title: 'Open shopping items, for the AI',
	input: z.object({}),
	output: AiContextSchema,
	readOnly: true,
	requires: listsView.id,
	async run(uow) {
		const rows = await tables(uow.db)
			.selectFrom('lists_shopping_items')
			.innerJoin('lists_shopping_lists', 'lists_shopping_lists.id', 'lists_shopping_items.list_id')
			.select([
				'lists_shopping_items.id as id',
				'lists_shopping_items.title as title',
				'lists_shopping_items.quantity as quantity',
				'lists_shopping_lists.name as list_name',
			])
			.where('lists_shopping_items.deleted_at', 'is', null)
			.where('lists_shopping_items.done_at', 'is', null)
			.where('lists_shopping_lists.archived_at', 'is', null)
			.orderBy('lists_shopping_items.created_at', 'desc')
			.orderBy('lists_shopping_items.id', 'desc')
			.limit(MAX_CONTEXT_ITEMS)
			.execute();
		return {
			kind: 'shop_item',
			label: 'Shopping items still to buy',
			items: rows.map((r) => ({
				id: r.id,
				label: r.title,
				details: [r.quantity, `list: ${r.list_name || DEFAULT_LIST_LABEL}`]
					.filter(Boolean)
					.join(', '),
			})),
		};
	},
});

/** The open tasks, for the AI, so a message saying one is done can complete it. */
export const aiContextTasks = defineAction({
	id: 'lists.aiContextTasks',
	title: 'Open tasks, for the AI',
	input: z.object({}),
	output: AiContextSchema,
	readOnly: true,
	requires: listsView.id,
	async run(uow) {
		const rows = await tables(uow.db)
			.selectFrom('lists_tasks')
			.select(['id', 'title', 'due_date'])
			.where('deleted_at', 'is', null)
			.where('done_at', 'is', null)
			.orderBy('created_at', 'desc')
			.orderBy('id', 'desc')
			.limit(MAX_CONTEXT_TASKS)
			.execute();
		return {
			kind: 'task',
			label: 'Open tasks',
			items: rows.map((r) => ({
				id: r.id,
				label: r.title,
				...(r.due_date && { details: `due ${r.due_date}` }),
			})),
		};
	},
});
