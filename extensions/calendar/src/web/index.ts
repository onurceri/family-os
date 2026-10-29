import { defineWebExtension } from '@famos/ui/slots';
import { CalendarDays, CalendarRange, Smartphone } from '@lucide/svelte';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import {
	changeEventPresenter,
	createEventPresenter,
	deleteEventPresenter,
	updateEventPresenter,
} from './presenter.js';
import { calendarTimeline, firstEventStep } from './timeline.js';

/** Calendar UI: the Calendar tab, its events on the Today timeline and the Inbox presenter for proposed events. */
export default defineWebExtension({
	manifest: pkg.famos,
	messages: en,
	labelKey: 'calendar:feature_name',
	descriptionKey: 'calendar:feature_description',
	offlineReads: ['/occurrences'],
	nav: [
		{
			id: 'calendar.nav',
			path: '/calendar',
			labelKey: 'calendar:nav',
			icon: CalendarDays,
			placement: 'primary',
			order: 20,
			shortcut: 'c',
			adds: 'calendar.createEvent',
		},
		// Settings: the personal feed addresses (You) and the family's subscriptions and tags (Family).
		{
			id: 'calendar.feedSettings',
			path: '/settings/calendar-feed',
			labelKey: 'calendar:nav_feed',
			icon: Smartphone,
			placement: 'more',
			group: 'settings',
			section: 'you',
			order: 50,
			requires: 'calendar.view',
		},
		{
			id: 'calendar.calendarsSettings',
			path: '/settings/calendars',
			labelKey: 'calendar:nav_calendars',
			icon: CalendarRange,
			placement: 'more',
			group: 'settings',
			section: 'family',
			order: 50,
			requires: 'calendar.manage',
		},
	],
	pages: [
		{ id: 'calendar.page', path: '/calendar', component: () => import('./CalendarPage.svelte') },
		{
			id: 'calendar.feeds',
			requires: 'calendar.view',
			path: '/settings/calendar-feed',
			component: () => import('./FeedsPage.svelte'),
		},
		{
			id: 'calendar.calendars',
			requires: 'calendar.manage',
			path: '/settings/calendars',
			component: () => import('./CalendarsPage.svelte'),
		},
	],
	slots: [
		{
			// This week on a screen of its own, between Today's turns on a family display.
			slot: 'display.page',
			id: 'calendar.week',
			labelKey: 'calendar:display_week',
			requires: 'calendar.view',
			component: () => import('./DisplayWeek.svelte'),
		},
	],
	timeline: [calendarTimeline],
	today: [firstEventStep],
	drafts: [createEventPresenter, changeEventPresenter, updateEventPresenter, deleteEventPresenter],
});
