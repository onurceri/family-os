import { defineNotificationKind } from '@famos/sdk';
import { CORE_CAPABILITIES } from '../core-capabilities.ts';

/** The member is told whenever an AI app is connected to their account. */
export const aiAppConnected = defineNotificationKind({
	id: 'core.aiAppConnected',
	label: 'app:notify_kind_ai_app_connected',
	audience: CORE_CAPABILITIES.mcpUse.id,
});
/** The member is told when an app's sign-in was cut off because it was used twice. */
export const aiAppDisconnected = defineNotificationKind({
	id: 'core.aiAppDisconnected',
	label: 'app:notify_kind_ai_app_disconnected',
	audience: CORE_CAPABILITIES.mcpUse.id,
});
export const oauthNotifications = [aiAppConnected, aiAppDisconnected];
