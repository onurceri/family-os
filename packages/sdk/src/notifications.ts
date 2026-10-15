import { z } from 'zod';

/**
 * Notifications. Extensions declare the kinds of things they tell people
 * (`defineNotificationKind`) and then call `uow.notify(...)` (actions) or `ctx.notify(...)` (jobs).
 * Core writes the in-app record and hands copies to the available channels.
 */
export interface NotificationKindDefinition {
	/** Namespaced by its owner: `inbox.itemFailed`, `core.draftWaiting`. */
	readonly id: string;
	/** i18n key for the preferences screen, e.g. `inbox:notify_kind_item_failed`. */
	readonly label: string;
	/** Channel ids switched on by default. Without it, every channel is on by default. */
	readonly defaultChannels?: readonly string[];
	/**
	 * A capability. Members without it never see this kind in their preferences and
	 * cannot set it. Delivery is unchanged: recipients come from the notify call.
	 */
	readonly audience?: string;
}

const KIND_ID = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

export function defineNotificationKind(
	definition: NotificationKindDefinition,
): NotificationKindDefinition {
	if (!KIND_ID.test(definition.id)) {
		throw new Error(
			`Invalid notification kind "${definition.id}": use "<owner>.<name>", e.g. "inbox.itemFailed"`,
		);
	}
	return definition;
}

/**
 * A date or a time in a notification. It is written out when the notification is delivered, so
 * its day and month names are in the recipient's language, with the family's region format,
 * hour cycle and time zone: `{ date: '2026-10-22' }` ("22 Oct 2026"), `{ time: '17:30' }` (a
 * local time of day) or `{ at: epochMs }` (the clock time of an instant, in `timeZone` when
 * given, else the family's).
 */
export const NotifyWhenSchema = z.union([
	z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
	z.strictObject({ time: z.string().regex(/^\d{2}:\d{2}$/) }),
	z.strictObject({ at: z.number().int(), timeZone: z.string().min(1).optional() }),
]);
export type NotifyWhen = z.infer<typeof NotifyWhenSchema>;

/** A translation key with parameters; rendered when delivered, in the recipient's language. */
export const NotifyTextSchema = z.object({
	key: z.string().min(1),
	params: z.record(z.string(), z.union([z.string(), z.number(), NotifyWhenSchema])).optional(),
});
export type NotifyText = z.infer<typeof NotifyTextSchema>;

export const NotifyRequestSchema = z.object({
	kind: z.string().min(1),
	to: z.object({
		/** Member ids. */
		members: z.array(z.string()).optional(),
		/** Everyone whose role holds this capability ("whoever may approve"). */
		capability: z.string().optional(),
		/** A member left out, usually the one who caused it. */
		except: z.string().optional(),
	}),
	title: NotifyTextSchema,
	body: NotifyTextSchema.optional(),
	/** A path inside the app, e.g. `/add`. */
	url: z.string().optional(),
	source: z.object({ kind: z.string(), id: z.string() }).optional(),
	/** Repeats with the same key collapse into one notification per recipient. */
	dedupeKey: z.string().optional(),
	/** Wait before resolving recipients and creating the notification, so repeats can collapse. */
	delayMs: z.number().int().min(0).optional(),
});
export type NotifyRequest = z.infer<typeof NotifyRequestSchema>;
