import { defineCapability, defineEvent } from '@famos/sdk';
import { connectionChangedPayload, itemsChangedPayload } from '../contract/index.ts';

/** What the family chose to show from Home Assistant. */
export const homeassistantView = defineCapability({
	id: 'homeassistant.view',
	label: 'homeassistant:cap_view',
	level: 'view',
});
/** Connecting, changing and disconnecting: the token is a credential of the whole home. */
export const homeassistantManage = defineCapability({
	id: 'homeassistant.manage',
	label: 'homeassistant:cap_manage',
	level: 'manage',
});

/** The connection was made, changed, checked or removed (the settings page reloads). */
export const connectionChanged = defineEvent(
	'homeassistant.connection.changed',
	connectionChangedPayload,
);

/** What the family shows from Home Assistant was added to, renamed, moved or removed. */
export const itemsChanged = defineEvent('homeassistant.items.changed', itemsChangedPayload);
