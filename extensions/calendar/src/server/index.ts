import { defineExtension } from '@famos/sdk';
import pkg from '../../package.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };
import tr from '../messages/tr.json' with { type: 'json' };
import {
	calendarEdit,
	calendarManage,
	calendarView,
	eventChanged,
	subscriptionChanged,
	tagChanged,
} from './capabilities.ts';
import { changeEvent, putOccurrenceBack } from './change-event.ts';
import { aiContextEvents } from './context.ts';
import { calendarDigest } from './digest.ts';
import { createEvent, deleteEvent, restoreEvent, updateEvent } from './event-actions.ts';
import { getEvent, listOccurrences } from './event-routes.ts';
import {
	carryStoppedFeeds,
	createFeed,
	endFeedsOf,
	feedRoute,
	listFeeds,
	revokeFeed,
	touchFeed,
} from './feeds.ts';
import { findEvents } from './find-events.ts';
import { reminderKind, remindJob } from './reminders.ts';
import { searchIndex } from './search.ts';
import { migrations } from './store.ts';
import {
	addSubscription,
	listSubscriptions,
	refreshJob,
	refreshSubscription,
	removeSubscription,
	updateSubscription,
} from './subscriptions.ts';
import { aiContext, deleteTag, listTags, updateTag } from './tags.ts';
import { calendarKinds } from './understand.ts';

export { changeEvent, putOccurrenceBack } from './change-event.ts';
export { createEvent, deleteEvent, restoreEvent, updateEvent } from './event-actions.ts';
export { findEvents } from './find-events.ts';
/**
 * Calendar extension: family events with members, all-day days and recurrence; secret ICS feeds
 * out and read-only subscriptions in.
 */
export {
	calendarEdit,
	calendarManage,
	calendarView,
	eventChanged,
	subscriptionChanged,
	tagChanged,
};

export default defineExtension({
	manifest: pkg.famos,
	messages: { en, tr },
	migrations,
	ai: { index: searchIndex, context: [aiContext.id, aiContextEvents.id], kinds: calendarKinds },
	actions: [
		findEvents,
		calendarDigest,
		createEvent,
		updateEvent,
		changeEvent,
		deleteEvent,
		restoreEvent,
		putOccurrenceBack,
		updateTag,
		deleteTag,
		aiContext,
		aiContextEvents,
		createFeed,
		revokeFeed,
		touchFeed,
		addSubscription,
		updateSubscription,
		removeSubscription,
		refreshSubscription,
	],
	routes: [listOccurrences, getEvent, listTags, listFeeds, feedRoute, listSubscriptions],
	events: [eventChanged, subscriptionChanged, tagChanged],
	capabilities: [calendarView, calendarEdit, calendarManage],
	notifications: [reminderKind],
	jobs: [remindJob, refreshJob],
	endCredentials: endFeedsOf,
	onRestore: carryStoppedFeeds,
});
