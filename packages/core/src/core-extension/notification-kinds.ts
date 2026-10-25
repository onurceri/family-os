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
