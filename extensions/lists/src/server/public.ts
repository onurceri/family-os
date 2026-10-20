import {
	ApiDateSchema,
	ApiInstantSchema,
	apiId,
	apiInstant,
	apiOutput,
	defineApi,
} from '@famos/sdk';
import { epochOf, RecurrenceSchema } from '@famos/time';
import { z } from 'zod';
import { CATEGORIES, type ShoppingItem, type ShoppingList, type Task } from '../contract/index.ts';

/**
 * What the lists offer on the public API: shopping lists and their items, and tasks. Moments are
 * instants with the offset of the family time zone; deadlines are written both as the family
 * writes them (`dueDate`, `dueTime`) and as the one moment (`due`).
 */
const MemberId = apiId('member');
const ListId = apiId('shop_list');
const ItemId = apiId('shop_item');
const TaskId = apiId('task');

export const PublicShoppingListSchema = z
	.object({
		id: ListId,
		version: z.number().int(),
		name: z
			.string()
			.describe('The list’s name; the list made on install is named in the family language'),
		isDefault: z
			.boolean()
			.describe('True for the list made on install, which has no name of its own'),
		openCount: z.number().int().describe('Items still to buy'),
	})
	.meta({ id: 'ShoppingList' });

export const PublicShoppingItemSchema = z
	.object({
		id: ItemId,
		version: z
			.number()
			.int()
			.describe('Counts every write; send it as `If-Match` to change only an unchanged item'),
		listId: ListId,
		title: z.string(),
		quantity: z.string().nullable().describe('How much, as written ("2 kg", "a dozen")'),
		category: z.enum(CATEGORIES).describe('The store section'),
		done: z.boolean().describe('True once it is bought'),
		doneAt: ApiInstantSchema.nullable(),
		addedBy: MemberId.nullable(),
	})
	.meta({ id: 'ShoppingItem' });

export const PublicTaskSchema = z
	.object({
		id: TaskId,
		version: z
			.number()
			.int()
			.describe('Counts every write; send it as `If-Match` to change only an unchanged task'),
		title: z.string(),
		notes: z.string().nullable(),
		assigneeId: MemberId.nullable().describe('Who should do it; null means anyone'),
		dueDate: ApiDateSchema.nullable(),
		dueTime: z.string().nullable().describe('HH:MM in the family time zone; only with a due date'),
		due: z
			.union([ApiInstantSchema, ApiDateSchema])
			.nullable()
			.describe('The deadline: an instant when there is a time, else the day, else null'),
		recurrence: RecurrenceSchema.nullable().describe('How it repeats; null for a one-off task'),
		rrule: z
			.string()
			.nullable()
			.describe('The repeat rule (RFC 5545) when it is more than `recurrence` can say'),
		done: z.boolean().describe('True for a one-off task that is done'),
		doneAt: ApiInstantSchema.nullable(),
		doneBy: MemberId.nullable(),
	})
	.meta({ id: 'Task' });

const projectList = (list: ShoppingList, translate: (key: string) => string) => ({
	id: list.id,
	version: list.version,
	name: list.name || translate('lists:default_list'),
	isDefault: list.name === '',
	openCount: list.openCount,
});

const projectItemOf = (item: ShoppingItem, timeZone: string) => ({
	id: item.id,
	version: item.version,
	listId: item.listId,
	title: item.title,
	quantity: item.quantity,
	category: item.category,
	done: item.doneAt !== null,
	doneAt: item.doneAt === null ? null : apiInstant(item.doneAt, timeZone),
	addedBy: item.addedBy,
});

const projectItem = apiOutput(PublicShoppingItemSchema, (item: ShoppingItem, { timeZone }) =>
	projectItemOf(item, timeZone),
);

const projectTaskOf = (task: Task, timeZone: string) => ({
	id: task.id,
	version: task.version,
	title: task.title,
	notes: task.notes,
	assigneeId: task.assigneeId,
	dueDate: task.dueDate,
	dueTime: task.dueTime,
	due:
		task.dueDate === null
			? null
			: task.dueTime === null
				? task.dueDate
				: apiInstant(epochOf(task.dueDate, task.dueTime, timeZone), timeZone),
	recurrence: task.recurrence,
	rrule: task.rrule,
	done: task.doneAt !== null,
	doneAt: task.doneAt === null ? null : apiInstant(task.doneAt, timeZone),
	doneBy: task.doneBy,
});

const projectTask = apiOutput(PublicTaskSchema, (task: Task, { timeZone }) =>
	projectTaskOf(task, timeZone),
);

const projectDeleted = (name: string, id: z.ZodType<string>) =>
	apiOutput(
		z.object({ id }).meta({ id: name }),
		(result: { id: string }) => ({ id: result.id }) as never,
	);

const addedOutput = apiOutput(
	z
		.object({
			listId: ListId,
			items: z.array(PublicShoppingItemSchema),
			addedIds: z
				.array(ItemId)
				.describe('The items this call created; the others were already there'),
		})
		.meta({ id: 'ShoppingItemsAdded' }),
	(result: { listId: string; items: ShoppingItem[]; addedIds: string[] }, { timeZone }) => ({
		listId: result.listId,
		items: result.items.map((i) => projectItemOf(i, timeZone)),
		addedIds: result.addedIds,
	}),
);

export const api = {
	listShoppingLists: defineApi({
		name: 'lists.listShoppingLists',
		method: 'get',
		path: '/shopping/lists',
		summary: 'The shopping lists with the number of items still to buy',
		output: apiOutput(z.array(PublicShoppingListSchema), (lists: ShoppingList[], { translate }) =>
			lists.map((l) => projectList(l, translate)),
		),
	}),
	listShoppingItems: defineApi({
		name: 'lists.listShoppingItems',
		method: 'get',
		path: '/shopping/lists/{listId}/items',
		summary:
			'The items of a list: what is still to buy in store-section order, then what was bought lately',
		output: apiOutput(z.array(PublicShoppingItemSchema), (items: ShoppingItem[], { timeZone }) =>
			items.map((i) => projectItemOf(i, timeZone)),
		),
	}),
	addShoppingItems: defineApi({
		name: 'lists.addShoppingItems',
		method: 'post',
		path: '/shopping/lists/{listId}/items',
		summary:
			'Add items to a list. An item already on it is not repeated (a new quantity replaces the old); a bought one comes back',
		omit: ['list'],
		describe: {
			listId: 'The list to add to',
			'items.quantity':
				'How much, as written: "2 kg", "3" or "a dozen"; leave it out when there is no amount',
			'items.category': 'The store section; without it the section last used for this product',
			whenOnList:
				'What happens to an item already on the list and not bought: `update` (the default) takes the new quantity and category, `keep` leaves it as it is',
		},
		output: addedOutput,
	}),
	addShoppingItemsDefault: defineApi({
		name: 'lists.addShoppingItemsDefault',
		method: 'post',
		path: '/shopping/items',
		summary:
			'Add items to the default shopping list, the one made when FamilyOS was installed. An item already on it is not repeated (a new quantity replaces the old); a bought one comes back',
		omit: ['list', 'listId'],
		describe: {
			'items.quantity':
				'How much, as written: "2 kg", "3" or "a dozen"; leave it out when there is no amount',
			'items.category': 'The store section; without it the section last used for this product',
			whenOnList:
				'What happens to an item already on the list and not bought: `update` (the default) takes the new quantity and category, `keep` leaves it as it is',
		},
		output: addedOutput,
	}),
	completeShoppingItem: defineApi({
		name: 'lists.completeShoppingItem',
		method: 'post',
		path: '/shopping/items/{itemId}/complete',
		params: { itemId: 'id' },
		fixed: { done: true },
		omit: ['label'],
		summary: 'Tick an item off as bought',
		output: projectItem,
	}),
	uncheckShoppingItem: defineApi({
		name: 'lists.uncheckShoppingItem',
		method: 'post',
		path: '/shopping/items/{itemId}/uncheck',
		params: { itemId: 'id' },
		fixed: { done: false },
		omit: ['label'],
		summary: 'Put a bought item back on the list',
		output: projectItem,
	}),
	patchShoppingItem: defineApi({
		name: 'lists.patchShoppingItem',
		method: 'patch',
		path: '/shopping/items/{itemId}',
		params: { itemId: 'id' },
		summary: 'Change the title, quantity or section of an item; what is left out stays',
		output: projectItem,
	}),
	deleteShoppingItem: defineApi({
		name: 'lists.deleteShoppingItem',
		method: 'delete',
		path: '/shopping/items/{itemId}',
		params: { itemId: 'id' },
		omit: ['label'],
		summary: 'Take an item off the list',
		output: projectDeleted('ShoppingItemDeleted', ItemId),
	}),
	listTasks: defineApi({
		name: 'lists.listTasks',
		method: 'get',
		path: '/tasks',
		summary: 'Open tasks, and the one-off tasks done in the last week',
		output: apiOutput(z.array(PublicTaskSchema), (tasks: Task[], { timeZone }) =>
			tasks.map((t) => projectTaskOf(t, timeZone)),
		),
	}),
	getTask: defineApi({
		name: 'lists.getTask',
		method: 'get',
		path: '/tasks/{taskId}',
		summary: 'One task',
		output: projectTask,
	}),
	addTask: defineApi({
		name: 'lists.addTask',
		method: 'post',
		path: '/tasks',
		summary: 'Add a task',
		describe: { recurrence: 'How the task repeats; needs a due date, which is the first one' },
		output: projectTask,
	}),
	replaceTask: defineApi({
		name: 'lists.replaceTask',
		method: 'put',
		path: '/tasks/{taskId}',
		params: { taskId: 'id' },
		summary:
			'Replace the whole task with what is sent (every field; null for one left empty). Needs `If-Match`',
		describe: {
			onlyThisDate:
				'A repeating task: moves only the due date now up to this day; the repeat and its start stay',
			keepRule:
				'True to keep a repeat rule that `recurrence` cannot say (the task shows it as `rrule`); without it a task sent with no `recurrence` stops repeating',
		},
		output: projectTask,
	}),
	patchTask: defineApi({
		name: 'lists.patchTask',
		method: 'patch',
		path: '/tasks/{taskId}',
		params: { taskId: 'id' },
		omit: ['label'],
		summary: 'Change some fields of a task; what is left out stays',
		output: apiOutput(PublicTaskSchema, (result: { task: Task }, { timeZone }) =>
			projectTaskOf(result.task, timeZone),
		),
	}),
	completeTask: defineApi({
		name: 'lists.completeTask',
		method: 'post',
		path: '/tasks/{taskId}/complete',
		params: { taskId: 'id' },
		omit: ['label'],
		describe: {
			dueDate:
				'The due date you saw. A task whose date has moved on since (a repeating one already completed) is left as it is',
		},
		summary: 'Mark a task done; a repeating task moves on to its next due date',
		output: projectTask,
	}),
	reopenTask: defineApi({
		name: 'lists.reopenTask',
		method: 'post',
		path: '/tasks/{taskId}/reopen',
		params: { taskId: 'id' },
		summary: 'Take the last completion of a task back',
		output: projectTask,
	}),
	deleteTask: defineApi({
		name: 'lists.deleteTask',
		method: 'delete',
		path: '/tasks/{taskId}',
		params: { taskId: 'id' },
		omit: ['label'],
		summary: 'Delete a task',
		output: projectDeleted('TaskDeleted', TaskId),
	}),
};
