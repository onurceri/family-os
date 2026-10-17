import { defineWebExtension } from '@famos/ui/slots';
import { PawPrint } from '@lucide/svelte';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import { addPetPresenter, addTreatmentPresenter } from './presenters.js';

/**
 * Pets UI: the Pets page and one page per pet (`/pets/:id`), which renders the `record.section`
 * slot so `records` shows what needs doing and the papers, and the pets as choices for the
 * Inbox's "Add to…".
 */
export default defineWebExtension({
	manifest: pkg.famos,
	messages: en,
	labelKey: 'pets:feature_name',
	descriptionKey: 'pets:feature_description',
	nav: [
		{
			id: 'pets.nav',
			path: '/pets',
			labelKey: 'pets:nav',
			icon: PawPrint,
			placement: 'more',
			group: 'household',
			order: 20,
			requires: 'pets.view',
		},
	],
	pages: [
		// One component for the list and a record, so opening one keeps the list mounted (read once).
		{
			id: 'pets.page',
			requires: 'pets.view',
			path: '/pets',
			component: () => import('./PetPage.svelte'),
		},
		{
			id: 'pets.pet',
			requires: 'pets.view',
			path: '/pets/:id',
			component: () => import('./PetPage.svelte'),
		},
	],
	slots: [
		{
			slot: 'inbox.fileTarget',
			id: 'pets.fileTarget',
			order: 20,
			requires: 'pets.view',
			component: () => import('./FileTargetPets.svelte'),
		},
	],
	drafts: [addPetPresenter, addTreatmentPresenter],
});
