import { unwrap } from '@famos/api-client';
import type { AppContext, RunActionResult } from '@famos/ui/app';
import { sharedRead } from '@famos/ui/famos';
import type {
	AddShoppingItemsInput,
	Category,
	ShoppingItem,
	ShoppingList,
	Task,
	TaskInput,
	TaskReplace,
} from '../contract/index.js';
import { type AddedItems, type AlreadyOnList, alreadyOnList } from './already-on-list.js';
import { api } from './api.js';

/** Lists API calls, all through the generated client. */
export type Outcome = 'applied' | 'drafted' | 'queued';

/** What the offline-capable calls need from the app (`useApp()`). */
type Runner = Pick<AppContext, 'runAction'>;
const outcomeOf = (result: RunActionResult): Outcome => (result.queued ? 'queued' : result.status);

/** Shared by everything that opens together (Today's cards and its timeline). */
export const loadTasks = (): Promise<Task[]> =>
	sharedRead('/api/v1/lists/tasks', async () => unwrap(await api.GET('/api/v1/lists/tasks')));

export const loadTask = async (taskId: string): Promise<Task> =>
	unwrap(await api.GET('/api/v1/lists/tasks/{taskId}', { params: { path: { taskId } } }));

/** Adds a task; `id` is the new task's, or null when it went to someone for approval. */
export async function addTask(task: TaskInput): Promise<{ outcome: Outcome; id: string | null }> {
	const result = unwrap(await api.POST('/api/v1/actions/lists.addTask', { body: task }));
	return { outcome: result.status, id: result.status === 'applied' ? result.output.id : null };
}

/** Saves the whole form: a new task without an id, or that task replaced by it. */
export async function saveTask(task: TaskReplace, id?: string): Promise<Outcome> {
	if (!id) return (await addTask(task)).outcome;
	return unwrap(await api.POST('/api/v1/actions/lists.updateTask', { body: { id, task } })).status;
}

/** Completes a task; the task after it, 'queued' without a connection, or null (a draft). */
export async function completeTask(
	app: Runner,
	task: Task,
	label: string,
): Promise<Task | 'queued' | null> {
	const result = await app.runAction<Task>(
		'lists.completeTask',
		{ id: task.id, dueDate: task.dueDate },
		{ offline: true, label },
	);
	if (result.queued) return 'queued';
	return result.status === 'applied' ? result.output : null;
}

export const reopenTask = async (app: Runner, id: string, label: string): Promise<Outcome> =>
	outcomeOf(await app.runAction('lists.reopenTask', { id }, { offline: true, label }));

export const deleteTask = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/lists.deleteTask', { body: { id } })).status;

export const loadLists = async (): Promise<ShoppingList[]> =>
	unwrap(await api.GET('/api/v1/lists/shopping/lists'));

export const loadItems = async (listId: string): Promise<ShoppingItem[]> =>
	unwrap(
		await api.GET('/api/v1/lists/shopping/lists/{listId}/items', { params: { path: { listId } } }),
	);

/** Adds items; `already` names those that were on the list already (nothing new to see). */
export async function addItems(
	app: Runner,
	input: AddShoppingItemsInput,
	label: string,
): Promise<{ outcome: Outcome; already: AlreadyOnList[]; addedIds: readonly string[] }> {
	const result = await app.runAction<AddedItems>('lists.addShoppingItems', input, {
		offline: true,
		label,
	});
	return {
		outcome: outcomeOf(result),
		already: !result.queued && result.status === 'applied' ? alreadyOnList(result.output) : [],
		addedIds: !result.queued && result.status === 'applied' ? result.output.addedIds : [],
	};
}

export const checkItem = async (
	app: Runner,
	id: string,
	done: boolean,
	label: string,
): Promise<Outcome> =>
	outcomeOf(await app.runAction('lists.checkShoppingItem', { id, done }, { offline: true, label }));

export const updateItem = async (
	id: string,
	patch: { title?: string; quantity?: string | null; category?: Category },
): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/lists.updateShoppingItem', { body: { id, ...patch } }))
		.status;

export const deleteItem = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/lists.deleteShoppingItem', { body: { id } })).status;

/** Takes back a removal: the same item returns, with its place and its bought state. */
export const restoreItem = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/lists.restoreShoppingItem', { body: { id } })).status;

export const clearBought = async (listId: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/lists.clearBought', { body: { listId } })).status;

export const createList = async (
	name: string,
): Promise<{ outcome: Outcome; id: string | null }> => {
	const result = unwrap(
		await api.POST('/api/v1/actions/lists.createShoppingList', { body: { name } }),
	);
	return { outcome: result.status, id: result.status === 'applied' ? result.output.id : null };
};

export const renameList = async (id: string, name: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/lists.renameShoppingList', { body: { id, name } })).status;

export const archiveList = async (id: string): Promise<Outcome> =>
	unwrap(await api.POST('/api/v1/actions/lists.archiveShoppingList', { body: { id } })).status;
