import { defineCapability, defineEvent } from '@famos/sdk';
import {
	connectionChangedPayload,
	itemsChangedPayload,
	peopleChangedPayload,
} from '../contract/index.ts';

/** What the family chose to show from Home Assistant. */
export const homeassistantView = defineCapability({
	id: 'homeassistant.view',
	label: 'homeassistant:cap_view',
	level: 'view',
});
/**
 * Who is home: what each linked person chose to show about themselves. A family decides in Roles
 * who sees it; a display shows it only when granted it, and only of those who chose to.
 */
export const homeassistantPresence = defineCapability({
	id: 'homeassistant.presence',
	label: 'homeassistant:cap_presence',
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

/** A person was linked or unlinked, or changed what they show (pages and Today reload). */
export const peopleChanged = defineEvent('homeassistant.people.changed', peopleChangedPayload);
