import { defineCapability } from '@famos/sdk';

/**
 * Core's capabilities. Critical ones are held by the Admin role alone: no custom role
 * can gain them, and a PIN sign-in never holds them (an admin signed in with a PIN does
 * everything else).
 */
export const CORE_CAPABILITIES = {
	membersView: defineCapability({
		id: 'core.members.view',
		label: 'app:cap_members_view',
		level: 'view',
	}),
	membersManage: defineCapability({
		id: 'core.members.manage',
		label: 'app:cap_members_manage',
		level: 'manage',
		critical: true,
	}),
	rolesManage: defineCapability({
		id: 'core.roles.manage',
		label: 'app:cap_roles_manage',
		level: 'manage',
		critical: true,
	}),
	devicesManage: defineCapability({
		id: 'core.devices.manage',
		label: 'app:cap_devices_manage',
		level: 'manage',
		critical: true,
	}),
	settingsManage: defineCapability({
		id: 'core.settings.manage',
		label: 'app:cap_settings_manage',
		level: 'manage',
		critical: true,
	}),
	aiManage: defineCapability({
		id: 'core.ai.manage',
		label: 'app:cap_ai_manage',
		level: 'manage',
		critical: true,
	}),
	featuresManage: defineCapability({
		id: 'core.features.manage',
		label: 'app:cap_features_manage',
		level: 'manage',
		critical: true,
	}),
	/** Install and uninstall extensions, and restart the server to load them. */
	extensionsManage: defineCapability({
		id: 'core.extensions.manage',
		label: 'app:cap_extensions_manage',
		level: 'manage',
		critical: true,
	}),
	/** Auto-approval approves as the person who turned it on, so only admins do. */
	autoApproveManage: defineCapability({
		id: 'core.autoApprove.manage',
		label: 'app:cap_auto_approve_manage',
		level: 'manage',
		critical: true,
	}),
	/**
	 * Register connected apps (Home Assistant, scripts), choose what they may do and give them
	 * keys. Critical: an app's key is a credential that works away from this home.
	 */
	appsManage: defineCapability({
		id: 'core.apps.manage',
		label: 'app:cap_apps_manage',
		level: 'manage',
		critical: true,
	}),
	/**
	 * Create personal API tokens, so AI apps can use FamilyOS through MCP. Not for supervised
	 * members by default: a token lets an app the family never chose read all they can see and
	 * send it to its own provider, outside the family's AI settings. An admin can still grant it.
	 */
	mcpUse: defineCapability({
		id: 'core.mcp.use',
		label: 'app:cap_mcp_use',
		level: 'use',
		defaults: { admin: true, member: true, supervised: false, guest: false },
	}),
	/** Keep personal notes the assistant remembers. */
	memoryUse: defineCapability({
		id: 'core.memory.use',
		label: 'app:cap_memory_use',
		level: 'use',
	}),
	draftsPropose: defineCapability({
		id: 'core.drafts.propose',
		label: 'app:cap_drafts_propose',
		level: 'use',
	}),
	draftsApprove: defineCapability({
		id: 'core.drafts.approve',
		label: 'app:cap_drafts_approve',
		level: 'edit',
	}),
	/** How many suggestions wait for a decision; a count only (the Quick add status of a display). */
	draftsWaiting: defineCapability({
		id: 'core.drafts.waiting',
		label: 'app:cap_drafts_waiting',
		level: 'view',
	}),
	/** Own notifications and preferences. */
	notificationsReceive: defineCapability({
		id: 'core.notifications.receive',
		label: 'app:cap_notifications_receive',
		level: 'view',
	}),
	/**
	 * Profile picker + PIN on trusted devices, for whoever an admin gives a PIN. Every built-in
	 * role may have one; a custom role can be kept to passwords.
	 */
	signInPin: defineCapability({
		id: 'core.signIn.pin',
		label: 'app:cap_sign_in_pin',
		level: 'use',
		defaults: { admin: true, member: true, supervised: true, guest: true },
	}),
} as const;
