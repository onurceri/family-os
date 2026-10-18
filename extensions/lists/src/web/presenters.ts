import { describeRecurrence } from '@famos/time';
import { type DraftPresenter, draftDate, type PresenterContext } from '@famos/ui/slots';
import { ListChecks, ShoppingCart } from '@lucide/svelte';
import type { AddShoppingItemsInput, TaskInput } from '../contract/index.js';
import { loadItems, loadLists } from './data.js';
import { draftDue } from './format.js';
import type { ListsT } from './i18n.js';
import { draftListName, itemsOnList, quantityChanges, shoppingLists } from './shopping-draft.js';
import {
	type ChangeTaskInput,
	changeTaskFields,
	type UpdateTaskInput,
	updateTaskFields,
} from './task-change.js';

const tr = (c: PresenterContext): ListsT =>
	((key: string, options?: Record<string, unknown>) => c.t(`lists:${key}`, options)) as ListsT;

/** How a proposed task looks in the Inbox (draft card). */
export const addTaskPresenter: DraftPresenter<TaskInput> = {
	actionId: 'lists.addTask',
	kind: (c) => c.t('lists:kind_task'),
	icon: ListChecks,
	title: (input) => input.title,
	fields(input, c) {
		const t = tr(c);
		const who = c.members.find((m) => m.id === input.assigneeId)?.displayName ?? t('anyone');
		const fields = [
			{
				label: t('due'),
				value: draftDue(
					{ dueDate: input.dueDate ?? null, dueTime: input.dueTime ?? null },
					c,
					t('no_due'),
				),
				paths: ['dueDate', 'dueTime'],
			},
			{ label: t('who'), value: who, path: 'assigneeId' },
		];
		if (input.recurrence) {
			const recurrence = { interval: 1, ...input.recurrence } as Parameters<
				typeof describeRecurrence
			>[0];
			fields.push({
				label: t('repeat'),
				value: describeRecurrence(
					recurrence,
					t,
					c.dateLocale,
					c.weekStart,
					input.dueDate ?? undefined,
				),
				path: 'recurrence',
			});
		}
		if (input.notes) fields.push({ label: t('notes'), value: input.notes, path: 'notes' });
		return fields;
	},
	approveLabel: (c) => c.t('lists:add_to_tasks'),
	editor: () => import('./TaskDraftEditor.svelte'),
};

const allLists = shoppingLists(loadLists);
const onList = itemsOnList(async (listId) => {
	const id = listId ?? (await loadLists())[0]?.id;
	return id ? loadItems(id) : [];
});

/**
 * Proposed shopping items: the title counts them, the field lists them with quantities, and a
 * second field names every item already on the list whose quantity the add would replace.
 */
export const addShoppingItemsPresenter: DraftPresenter<AddShoppingItemsInput> = {
	actionId: 'lists.addShoppingItems',
	kind: (c) => c.t('lists:kind_shopping'),
	icon: ShoppingCart,
	title: (input, c) =>
		input.items.length === 1
			? (input.items[0]?.title ?? '')
			: tr(c)('items_count', { count: input.items.length }),
	fields(input, c) {
		const value = input.items
			.map((i) => (i.quantity ? `${i.title} (${i.quantity})` : i.title))
			.join(', ');
		const t = tr(c);
		const fields = [{ label: t('items'), value, path: 'items' }];
		const list = draftListName(allLists(), input.listId, c.t('lists:default_list'));
		if (list) fields.push({ label: t('list'), value: list, path: 'listId' });
		const changes = quantityChanges(
			input.items,
			onList(input.listId) ?? [],
			c.formatLocale,
			input.whenOnList,
		);
		if (changes.length)
			fields.push({
				label: t('items_changed'),
				value: changes.map((change) => t('quantity_change', { ...change })).join(', '),
				path: 'items',
			});
		return fields;
	},
	approveLabel: (c) => c.t('lists:add_to_list'),
	editor: () => import('./ShoppingDraftEditor.svelte'),
};

/** A proposed change to an existing task: only what changes is listed, as "old → new". */
export const changeTaskPresenter: DraftPresenter<ChangeTaskInput> = {
	actionId: 'lists.changeTask',
	kind: (c) => c.t('lists:kind_task_change'),
	icon: ListChecks,
	// The label is the model's copy of the title it was shown; the id is what is acted on.
	title: (input, c) => input.label || input.title || c.t('lists:draft_a_task'),
	fields: (input, c, before) => changeTaskFields(input, c, before),
	approveLabel: (c) => c.t('lists:draft_approve_change'),
};

/**
 * An edit of a task saved by someone whose changes need approval: named by the task as it is
 * now, listing only what the edit changes ("old → new"). Once decided nothing is compared any
 * more, so the task is shown as the edit had it.
 */
export const updateTaskPresenter: DraftPresenter<UpdateTaskInput> = {
	actionId: 'lists.updateTask',
	kind: (c) => c.t('lists:kind_task_change'),
	icon: ListChecks,
	title: (input, c) => input.label || input.task.title || c.t('lists:draft_a_task'),
	fields: (input, c, before) =>
		before ? updateTaskFields(input, c, before) : addTaskPresenter.fields(input.task, c),
	approveLabel: (c) => c.t('lists:draft_approve_change'),
};

/** A proposal to mark a task done. */
export const completeTaskPresenter: DraftPresenter<{
	id: string;
	label?: string;
	dueDate?: string | null;
}> = {
	actionId: 'lists.completeTask',
	kind: (c) => c.t('lists:kind_task'),
	icon: ListChecks,
	title: (input, c) => input.label || c.t('lists:draft_a_task'),
	// Says what will happen, so it never reads like a suggestion to add the task.
	fields: (input, c) => [
		{ label: c.t('lists:draft_change'), value: c.t('lists:draft_approve_done'), path: 'id' },
		...(input.dueDate
			? [{ label: c.t('lists:due'), value: draftDate(input.dueDate, c), path: 'dueDate' }]
			: []),
	],
	approveLabel: (c) => c.t('lists:draft_approve_done'),
};

/** A proposal to tick off (or put back) a shopping item. */
export const checkShoppingItemPresenter: DraftPresenter<{
	id: string;
	done: boolean;
	label?: string;
}> = {
	actionId: 'lists.checkShoppingItem',
	kind: (c) => c.t('lists:kind_shopping'),
	icon: ShoppingCart,
	title: (input, c) => input.label || c.t('lists:draft_an_item'),
	fields: (input, c) => [
		{
			label: c.t('lists:draft_change'),
			value: input.done ? c.t('lists:draft_mark_bought') : c.t('lists:draft_put_back'),
			path: 'done',
		},
	],
	approveLabel: (c) => c.t('lists:draft_approve_apply'),
};

/** A proposal to delete a task. */
export const deleteTaskPresenter: DraftPresenter<{ id: string; label?: string }> = {
	actionId: 'lists.deleteTask',
	removes: true,
	kind: (c) => c.t('lists:kind_task_remove'),
	icon: ListChecks,
	title: (input, c) => input.label || c.t('lists:draft_a_task'),
	fields: () => [],
	approveLabel: (c) => c.t('lists:draft_approve_delete'),
};

/** A proposal to remove a shopping item that is no longer needed. */
export const deleteShoppingItemPresenter: DraftPresenter<{ id: string; label?: string }> = {
	actionId: 'lists.deleteShoppingItem',
	removes: true,
	kind: (c) => c.t('lists:kind_shopping_remove'),
	icon: ShoppingCart,
	title: (input, c) => input.label || c.t('lists:draft_an_item'),
	fields: () => [],
	approveLabel: (c) => c.t('lists:draft_approve_delete'),
};

/** A proposal to remove several shopping items at once: it names how many, as the ids carry no names. */
export const deleteShoppingItemsPresenter: DraftPresenter<{ ids: readonly string[] }> = {
	actionId: 'lists.removeShoppingItems',
	kind: (c) => c.t('lists:kind_shopping_remove'),
	icon: ShoppingCart,
	title: (input, c) => tr(c)('items_count', { count: input.ids.length }),
	fields: () => [],
	approveLabel: (c) => c.t('lists:draft_approve_delete'),
};
