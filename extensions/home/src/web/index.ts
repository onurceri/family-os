import { defineWebExtension } from '@famos/ui/slots';
import { House } from '@lucide/svelte';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import {
	addHomePresenter,
	addItemPresenter,
	archiveHomePresenter,
	archiveItemPresenter,
	archiveServicePresenter,
	updateItemPresenter,
} from './presenters.js';

/**
 * Home UI: the Home page (homes), one page per home (`/home/:id`), per thing
 * (`/home/items/:id`) and per service (`/home/services/:id`), each rendering the `record.section`
 * slot so `records` shows what needs doing and the papers, and homes, things and services as
 * choices for the Inbox's "Add to…".
 */
export default defineWebExtension({
	manifest: pkg.famos,
	messages: en,
	labelKey: 'home:feature_name',
	descriptionKey: 'home:feature_description',
	nav: [
		{
			id: 'home.nav',
			path: '/home',
			labelKey: 'home:nav',
			icon: House,
			placement: 'more',
			group: 'household',
			order: 20,
			requires: 'home.view',
		},
	],
	pages: [
		// One component for the list and a record, so opening one keeps the list mounted (read once).
		{
			id: 'home.page',
			requires: 'home.view',
			path: '/home',
			component: () => import('./HomePage.svelte'),
		},
		{
			id: 'home.home',
			requires: 'home.view',
			path: '/home/:id',
			component: () => import('./HomePage.svelte'),
		},
		{
			id: 'home.item',
			requires: 'home.view',
			path: '/home/items/:id',
			component: () => import('./ItemPage.svelte'),
		},
		{
			id: 'home.service',
			requires: 'home.view',
			path: '/home/services/:id',
			component: () => import('./ServicePage.svelte'),
		},
	],
	slots: [
		{
			slot: 'inbox.fileTarget',
			id: 'home.fileTarget',
			order: 20,
			requires: 'home.view',
			component: () => import('./FileTargetHome.svelte'),
		},
	],
	drafts: [
		addHomePresenter,
		addItemPresenter,
		updateItemPresenter,
		archiveHomePresenter,
		archiveItemPresenter,
		archiveServicePresenter,
	],
});
