import type { ExtensionContext } from './context.ts';
import type { JobContext } from './jobs.ts';
import type { NotificationMessage } from './ports.ts';

/**
 * A way to reach a person outside the app that an extension adds (a home automation hub, a chat
 * service). The host binds it to the extension: `isAvailableFor` runs with the extension's own
 * context and `send` with the one its jobs get, so its tables, secrets, network and logger
 * apply. Like every channel it carries a copy of the in-app list.
 */
export interface NotificationChannelDefinition {
	/** The extension's id, or `<extension id>.<name>`. */
	readonly id: string;
	/** i18n key shown in preferences, e.g. `homeassistant:channel_label`. */
	readonly label: string;
	/** i18n key shown to a member for whom the channel is not available; without it, they see nothing. */
	readonly hint?: string;
	/**
	 * Whether the channel is on for a kind that names no default channels, until a member chooses.
	 * Default `on`.
	 */
	readonly byDefault?: 'on' | 'off';
	/** Whether this member can be reached. A throw counts as not available. */
	isAvailableFor(ctx: ExtensionContext, memberId: string): Promise<boolean>;
	/** `gone`: the member's target no longer exists. Throw to retry later. */
	send(ctx: JobContext, memberId: string, message: NotificationMessage): Promise<'sent' | 'gone'>;
}

const CHANNEL_ID = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)?$/;

export function defineNotificationChannel(
	definition: NotificationChannelDefinition,
): NotificationChannelDefinition {
	if (!CHANNEL_ID.test(definition.id)) {
		throw new Error(
			`Invalid notification channel "${definition.id}": use the extension id or "<extension id>.<name>"`,
		);
	}
	return definition;
}
