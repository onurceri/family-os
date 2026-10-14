import type { AnyDraftPresenter, DraftPresenter, SlotContribution } from '@famos/ui/slots';
import { BookmarkPlus } from '@lucide/svelte';

/**
 * Contributions the app itself makes to slots (an extension never owns these). The navigation
 * puts the notifications bell into `today.head` here, for phones, whose bell lives in the page
 * head of Today:
 *
 * ```ts
 * { slot: 'today.head', id: 'app.bell', component: () => import('./NotificationsBell.svelte') }
 * ```
 *
 * Ids are namespaced `app.<name>`; the app is never "turned off" like an extension.
 */
export const appSlotContributions: SlotContribution[] = [
	{ slot: 'today.head', id: 'app.bell', component: () => import('./TodayBell.svelte') },
];

/** "Remember: …?" The note is private to the person who sees this card. */
const addMemoryPresenter: DraftPresenter<{ text: string }> = {
	actionId: 'core.addMemory',
	kind: (c) => c.t('app:memory_kind'),
	icon: BookmarkPlus,
	title: (input, c) => c.t('app:memory_remember_title', { text: input.text }),
	fields: () => [],
	approveLabel: (c) => c.t('app:memory_remember_approve'),
};

/**
 * How drafts of core's own actions are shown: whoever proposes them (the assistant, a connected
 * app), core is part of the app, so the app presents them.
 */
export const appDraftPresenters: AnyDraftPresenter[] = [addMemoryPresenter];
