import { defineWebExtension } from '@famos/ui/slots';
import { Car } from '@lucide/svelte';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import { addLogPresenter, addVehiclePresenter } from './presenters.js';

/**
 * Vehicles UI: the Vehicles page and one page per vehicle (`/vehicles/:id`), which renders the
 * `record.section` slot so `records` shows what needs doing and the papers, and the vehicles as
 * choices for the Inbox's "Add to…".
 */
export default defineWebExtension({
	manifest: pkg.famos,
	messages: en,
	labelKey: 'vehicles:feature_name',
	descriptionKey: 'vehicles:feature_description',
	nav: [
		{
			id: 'vehicles.nav',
			path: '/vehicles',
			labelKey: 'vehicles:nav',
			icon: Car,
			placement: 'more',
			group: 'household',
			order: 10,
			requires: 'vehicles.view',
		},
	],
	pages: [
		// One component for the list and a record, so opening one keeps the list mounted (read once).
		{
			id: 'vehicles.page',
			requires: 'vehicles.view',
			path: '/vehicles',
			component: () => import('./VehiclePage.svelte'),
		},
		{
			id: 'vehicles.vehicle',
			requires: 'vehicles.view',
			path: '/vehicles/:id',
			component: () => import('./VehiclePage.svelte'),
		},
	],
	slots: [
		{
			slot: 'inbox.fileTarget',
			id: 'vehicles.fileTarget',
			order: 10,
			requires: 'vehicles.view',
			component: () => import('./FileTargetVehicles.svelte'),
		},
	],
	drafts: [addVehiclePresenter, addLogPresenter],
});
