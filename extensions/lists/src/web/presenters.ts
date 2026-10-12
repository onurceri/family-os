import { describeRecurrence, todayIn } from '@famos/time';
import type { DraftPresenter, PresenterContext } from '@famos/ui/slots';
import { ListChecks, ShoppingCart } from '@lucide/svelte';
import type { AddShoppingItemsInput, TaskInput } from '../contract/index.js';
import { loadItems, loadLists } from './data.js';
import { dueLabel } from './format.js';
import type { ListsT } from './i18n.js';
import { draftListName, itemsOnList, quantityChanges, shoppingLists } from './shopping-draft.js';

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
		const today = todayIn(c.timeZone, Date.now());
		const fields = [
			{
				label: t('due'),
				value: dueLabel(
					{ dueDate: input.dueDate ?? null, dueTime: input.dueTime ?? null },
					today,
					t,
					c.formatLocale,
					c.hourCycle,
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
				value: describeRecurrence(recurrence, t, c.formatLocale, c.weekStart),
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
		const list = draftListName(allLists(), input.listId);
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

type ChangeTaskInput = {
	id: string;
	label?: string;
	title?: string;
	assigneeId?: string | null;
	dueDate?: string | null;
	dueTime?: string | null;
	notes?: string | null;
};

/** A proposed change to an existing task: only what changes is listed. */
export const changeTaskPresenter: DraftPresenter<ChangeTaskInput> = {
	actionId: 'lists.changeTask',
	kind: (c) => c.t('lists:kind_task_change'),
	icon: ListChecks,
	// The label is the model's copy of the title it was shown; the id is what is acted on.
	title: (input, c) => input.label || input.title || c.t('lists:draft_a_task'),
	fields(input, c) {
		const t = tr(c);
		const fields: { label: string; value: string; path?: string; paths?: string[] }[] = [];
		if (input.title !== undefined && input.title !== input.label)
			fields.push({ label: t('draft_new_title'), value: input.title, path: 'title' });
		if (input.assigneeId !== undefined)
			fields.push({
				label: t('who'),
				value: c.members.find((m) => m.id === input.assigneeId)?.displayName ?? t('anyone'),
				path: 'assigneeId',
			});
		if (input.dueDate !== undefined || input.dueTime !== undefined)
			fields.push({
				label: t('due'),
				value: input.dueDate
					? dueLabel(
							{ dueDate: input.dueDate, dueTime: input.dueTime ?? null },
							todayIn(c.timeZone, Date.now()),
							t,
							c.formatLocale,
							c.hourCycle,
						)
					: t('no_due'),
				paths: ['dueDate', 'dueTime'],
			});
		if (input.notes !== undefined)
			fields.push({ label: t('notes'), value: input.notes || '—', path: 'notes' });
		return fields;
	},
	approveLabel: (c) => c.t('lists:draft_approve_change'),
};

/** A proposal to mark a task done. */
export const completeTaskPresenter: DraftPresenter<{ id: string; label?: string }> = {
	actionId: 'lists.completeTask',
	kind: (c) => c.t('lists:kind_task'),
	icon: ListChecks,
	title: (input, c) => input.label || c.t('lists:draft_a_task'),
	fields: () => [],
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
	kind: (c) => c.t('lists:kind_task_remove'),
	icon: ListChecks,
	title: (input, c) => input.label || c.t('lists:draft_a_task'),
	fields: () => [],
	approveLabel: (c) => c.t('lists:draft_approve_delete'),
};

/** A proposal to remove a shopping item that is no longer needed. */
export const deleteShoppingItemPresenter: DraftPresenter<{ id: string; label?: string }> = {
	actionId: 'lists.deleteShoppingItem',
	kind: (c) => c.t('lists:kind_shopping_remove'),
	icon: ShoppingCart,
	title: (input, c) => input.label || c.t('lists:draft_an_item'),
	fields: () => [],
	approveLabel: (c) => c.t('lists:draft_approve_delete'),
};
