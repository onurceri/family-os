import { defineCapability, defineEvent } from '@famos/sdk';
import { kitchenChangedPayload } from '../contract/index.ts';

/** What the kitchen protects. */
export const kitchenView = defineCapability({
	id: 'kitchen.view',
	label: 'kitchen:cap_view',
	level: 'view',
});
export const kitchenEdit = defineCapability({
	id: 'kitchen.edit',
	label: 'kitchen:cap_edit',
	level: 'edit',
});

export const kitchenChanged = defineEvent('kitchen.changed', kitchenChangedPayload, {
	audience: 'kitchen.view',
});
