import { defineCapability, defineEvent } from '@famos/sdk';
import { z } from 'zod';
import { eventChangedPayload } from '../contract/index.ts';

/** What the calendar protects: seeing it, changing it directly, and its connections. */
export const calendarView = defineCapability({
	id: 'calendar.view',
	label: 'calendar:cap_view',
	level: 'view',
});
export const calendarEdit = defineCapability({
	id: 'calendar.edit',
	label: 'calendar:cap_edit',
	level: 'edit',
});
/** Subscriptions to external calendars, and feeds of the whole family. */
export const calendarManage = defineCapability({
	id: 'calendar.manage',
	label: 'calendar:cap_manage',
	level: 'manage',
});

export const eventChanged = defineEvent('calendar.event.changed', eventChangedPayload, {
	audience: 'calendar.view',
	changes: ({ eventId, op }) => [{ entity: 'event', id: eventId, op: op ?? 'upsert' }],
});
/** A subscription was added, changed, removed or refreshed (the agenda reloads). */
export const subscriptionChanged = defineEvent(
	'calendar.subscription.changed',
	z.object({ subscriptionId: z.string(), op: z.enum(['upsert', 'delete']).optional() }),
	{
		audience: 'calendar.view',
		changes: ({ subscriptionId, op }) => [
			{ entity: 'subscription', id: subscriptionId, op: op ?? 'upsert' },
		],
	},
);
/** A tag was renamed, recoloured or deleted (the agenda reloads). */
export const tagChanged = defineEvent('calendar.tag.changed', z.object({}), {
	// No name: a tag's name is read through the calendar's own routes, by those who may.
	audience: 'calendar.view',
});
