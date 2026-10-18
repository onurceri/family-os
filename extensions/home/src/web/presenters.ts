import { type DraftPresenter, draftDate } from '@famos/ui/slots';
import { House, Refrigerator } from '@lucide/svelte';
import type { AddHomeInput, AddItemInput, UpdateItemInput } from '../contract/index.js';

/** How a suggested home reads in the Inbox. */
export const addHomePresenter: DraftPresenter<AddHomeInput> = {
	actionId: 'home.addHome',
	kind: (c) => c.t('home:kind_home'),
	icon: House,
	title: (input) => input.name,
	fields: (input, c) => [
		...(input.address
			? [{ label: c.t('home:field_address'), value: input.address, path: 'address' }]
			: []),
	],
	approveLabel: (c) => c.t('home:draft_approve_add'),
};

/** A thing bought, as the AI reads it from a receipt or warranty card or a person suggests it. */
export const addItemPresenter: DraftPresenter<AddItemInput> = {
	actionId: 'home.addItem',
	kind: (c) => c.t('home:kind_item'),
	icon: Refrigerator,
	title: (input) => (input.homeName ? `${input.name} · ${input.homeName}` : input.name),
	fields: (input, c) => [
		...(input.brand || input.model
			? [
					{
						label: c.t('home:draft_make'),
						value: [input.brand, input.model].filter(Boolean).join(' '),
						path: 'brand',
					},
				]
			: []),
		...(input.purchasedOn
			? [
					{
						label: c.t('home:field_purchased_on'),
						value: draftDate(input.purchasedOn, c),
						path: 'purchasedOn',
					},
				]
			: []),
		...(input.warrantyUntil
			? [
					{
						label: c.t('home:field_warranty_until'),
						value: draftDate(input.warrantyUntil, c),
						path: 'warrantyUntil',
					},
				]
			: []),
	],
	approveLabel: (c) => c.t('home:draft_approve_add'),
};

/** A change to a listed thing, such as an extended warranty. */
export const updateItemPresenter: DraftPresenter<UpdateItemInput & { label?: string }> = {
	actionId: 'home.updateItem',
	kind: (c) => c.t('home:kind_item_change'),
	icon: Refrigerator,
	title: (input, c) => input.itemName || input.label || input.name || c.t('home:kind_item'),
	fields: (input, c) => [
		...(input.warrantyUntil
			? [
					{
						label: c.t('home:field_warranty_until'),
						value: draftDate(input.warrantyUntil, c),
						path: 'warrantyUntil',
					},
				]
			: []),
		...(input.purchasedOn
			? [
					{
						label: c.t('home:field_purchased_on'),
						value: draftDate(input.purchasedOn, c),
						path: 'purchasedOn',
					},
				]
			: []),
		...(input.brand || input.model
			? [
					{
						label: c.t('home:draft_make'),
						value: [input.brand, input.model].filter(Boolean).join(' '),
						path: 'model',
					},
				]
			: []),
	],
	approveLabel: (c) => c.t('home:draft_approve_update'),
};
