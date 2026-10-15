import { defineWebExtension } from '@famos/ui/slots';
import { ListChecks, ListTodo, ShoppingBasket } from '@lucide/svelte';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import {
	addShoppingItemsPresenter,
	addTaskPresenter,
	changeTaskPresenter,
	checkShoppingItemPresenter,
	completeTaskPresenter,
	deleteShoppingItemPresenter,
	deleteTaskPresenter,
	updateTaskPresenter,
} from './presenters.js';
import { tasksTimeline } from './timeline.js';

/**
 * Lists UI: two pages, Tasks and Shopping (a group in the sidebar, one Lists tab on the phone
 * that opens the page used last), Today cards and Quick add presenters.
 */
export default defineWebExtension({
	manifest: pkg.famos,
	messages: en,
	labelKey: 'lists:feature_name',
	descriptionKey: 'lists:feature_description',
	nav: [
		{
			id: 'lists.nav',
			path: '/lists',
			labelKey: 'lists:nav',
			icon: ListChecks,
			placement: 'primary',
			order: 30,
			children: [
				{ id: 'lists.nav.tasks', path: '/lists/tasks', labelKey: 'lists:tasks', icon: ListTodo },
				{
					id: 'lists.nav.shopping',
					path: '/lists/shopping',
					labelKey: 'lists:shopping',
					icon: ShoppingBasket,
				},
			],
		},
	],
	pages: [
		{ id: 'lists.page', path: '/lists', component: () => import('./ListsHome.svelte') },
		{ id: 'lists.tasksPage', path: '/lists/tasks', component: () => import('./TasksPage.svelte') },
		{
			id: 'lists.shoppingPage',
			path: '/lists/shopping',
			component: () => import('./ShoppingPage.svelte'),
		},
	],
	slots: [
		{
			slot: 'dashboard.card',
			id: 'lists.overdue',
			band: 'needs',
			order: 20,
			component: () => import('./OverdueCard.svelte'),
		},
		{
			slot: 'dashboard.card',
			id: 'lists.tasks',
			band: 'notes',
			labelKey: 'lists:today_block_tasks',
			hintKey: 'lists:today_block_tasks_hint',
			order: 20,
			todo: true,
			component: () => import('./TasksCard.svelte'),
		},
		{
			slot: 'dashboard.card',
			id: 'lists.shopping',
			band: 'notes',
			labelKey: 'lists:today_block_shopping',
			hintKey: 'lists:today_block_shopping_hint',
			order: 30,
			glance: true,
			requires: 'lists.view',
			component: () => import('./ShoppingCard.svelte'),
		},
		{
			slot: 'display.widget',
			id: 'lists.tasks',
			order: 20,
			requires: 'lists.view',
			component: () => import('./DisplayTasks.svelte'),
		},
	],
	timeline: [tasksTimeline],
	drafts: [
		addTaskPresenter,
		addShoppingItemsPresenter,
		changeTaskPresenter,
		updateTaskPresenter,
		completeTaskPresenter,
		checkShoppingItemPresenter,
		deleteTaskPresenter,
		deleteShoppingItemPresenter,
	],
});
