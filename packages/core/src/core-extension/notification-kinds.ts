import { defineNotificationKind } from '@famos/sdk';

/** Admins are told when an off-site backup could not be uploaded. */
export const backupFailed = defineNotificationKind({
	id: 'core.backupFailed',
	label: 'app:notify_kind_backup_failed',
	audience: 'core.settings.manage',
});

/** Admins are told what a restore kept from before it, and that everyone signs in again. */
export const backupRestored = defineNotificationKind({
	id: 'core.backupRestored',
	label: 'app:notify_kind_backup_restored',
	audience: 'core.settings.manage',
});

/** Admins are told when a newer version of an extension they downloaded is out (weekly check). */
export const extensionUpdates = defineNotificationKind({
	id: 'core.extensionUpdates',
	label: 'app:notify_kind_extension_updates',
	audience: 'core.extensions.manage',
});

/**
 * Admins are told when a newer FamilyOS is out (weekly check), once per version. It is only
 * told: FamilyOS never updates itself.
 */
export const productUpdate = defineNotificationKind({
	id: 'core.productUpdate',
	label: 'app:notify_kind_product_update',
	audience: 'core.extensions.manage',
});

/** The person behind a suggestion is told when someone else approved or rejected it. */
export const draftDecided = defineNotificationKind({
	id: 'core.draftDecided',
	label: 'app:notify_kind_draft_decided',
	audience: 'core.drafts.propose',
});

/** Approvers are told when a suggestion waits for them (sent by the action runner). */
export const draftWaiting = defineNotificationKind({
	id: 'core.draftWaiting',
	label: 'app:notify_kind_draft_waiting',
	audience: 'core.drafts.approve',
});
