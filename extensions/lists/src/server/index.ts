import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import { aiContext, aiContextTasks } from './context.ts';
import { remindJob, taskDueKind } from './reminders.ts';
import {
	addShoppingItems,
	archiveShoppingList,
	checkShoppingItem,
	clearBought,
	createShoppingList,
	deleteShoppingItem,
	listShoppingItems,
	listShoppingLists,
	removeShoppingItems,
	renameShoppingList,
	restoreShoppingItem,
	restoreShoppingItems,
	shoppingChanged,
	shoppingEdit,
	shoppingList,
	shoppingManage,
	undoAddShoppingItems,
	updateShoppingItem,
} from './shopping.ts';
import { migrations } from './store.ts';
import {
	addTask,
	changeTask,
	completeTask,
	deleteTask,
	getTask,
	listsView,
	listTasks,
	openTasks,
	reopenTask,
	restoreTask,
	taskChanged,
	tasksComplete,
	tasksEdit,
	updateTask,
} from './tasks.ts';
import { listKinds } from './understand.ts';

/** Lists extension: family tasks (with repeating chores) and shopping lists. */
export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	ai: { context: [aiContext.id, aiContextTasks.id], kinds: listKinds },
	actions: [
		openTasks,
		shoppingList,
		aiContext,
		aiContextTasks,
		addTask,
		updateTask,
		changeTask,
		completeTask,
		reopenTask,
		deleteTask,
		restoreTask,
		addShoppingItems,
		updateShoppingItem,
		checkShoppingItem,
		deleteShoppingItem,
		restoreShoppingItem,
		restoreShoppingItems,
		removeShoppingItems,
		undoAddShoppingItems,
		clearBought,
		createShoppingList,
		renameShoppingList,
		archiveShoppingList,
	],
	routes: [listTasks, getTask, listShoppingLists, listShoppingItems],
	events: [taskChanged, shoppingChanged],
	capabilities: [listsView, tasksEdit, tasksComplete, shoppingEdit, shoppingManage],
	notifications: [taskDueKind],
	jobs: [remindJob],
});
