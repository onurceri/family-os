import { unwrap } from '@famos/api-client';
import { sharedRead } from '@famos/ui/famos';
import type {
	EventDetail,
	EventInput,
	EventReplace,
	Feed,
	Occurrence,
	Subscription,
	Tag,
} from '../contract/index.js';
import { api } from './api.js';

/** Calendar API calls, all through the generated client. */
/** Shared by everything that opens together (Today's timeline and the weather sentence). */
export function loadRange(from: string, to: string): Promise<Occurrence[]> {
	return sharedRead(`/api/v1/calendar/occurrences?from=${from}&to=${to}`, async () =>
		unwrap(await api.GET('/api/v1/calendar/occurrences', { params: { query: { from, to } } })),
	);
}

export async function loadEvent(eventId: string): Promise<EventDetail> {
	return unwrap(
		await api.GET('/api/v1/calendar/events/{eventId}', { params: { path: { eventId } } }),
	);
}

export type Outcome = 'applied' | 'drafted';

export async function createEvent(event: EventInput): Promise<Outcome> {
	return unwrap(await api.POST('/api/v1/actions/calendar.createEvent', { body: event })).status;
}

/** Replaces the event with the whole form. */
export async function replaceEvent(id: string, event: EventReplace): Promise<Outcome> {
	return unwrap(await api.POST('/api/v1/actions/calendar.updateEvent', { body: { id, event } }))
		.status;
}

export async function deleteEvent(id: string, occurrence?: string): Promise<Outcome> {
	const body = occurrence ? { id, occurrence } : { id };
	return unwrap(await api.POST('/api/v1/actions/calendar.deleteEvent', { body })).status;
}

export { onDay } from './board.js';

/* ───────────── Feeds out and subscriptions in ───────────── */

export async function loadFeeds(): Promise<Feed[]> {
	return unwrap(await api.GET('/api/v1/calendar/feeds'));
}

/** The address comes back once; it is never stored on the server in the clear. */
export async function createFeed(input: {
	scope: string;
	includeNotes: boolean;
	label?: string;
}): Promise<{ feed: Feed; token: string; path: string }> {
	const result = unwrap(await api.POST('/api/v1/actions/calendar.createFeed', { body: input }));
	if (result.status !== 'applied') throw new Error('Feed creation was not applied');
	return result.output;
}

export async function revokeFeed(id: string): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/calendar.revokeFeed', { body: { id } }));
}

export async function loadSubscriptions(): Promise<Subscription[]> {
	return unwrap(await api.GET('/api/v1/calendar/subscriptions'));
}

export async function addSubscription(input: {
	name: string;
	url: string;
	color: string;
	memberIds: string[];
	reminders: boolean;
	allowLocal: boolean;
}): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/calendar.addSubscription', { body: input }));
}

export async function updateSubscription(input: {
	id: string;
	name?: string;
	url?: string;
	color?: string;
	memberIds?: string[];
	reminders?: boolean;
	allowLocal?: boolean;
}): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/calendar.updateSubscription', { body: input }));
}

export async function removeSubscription(id: string): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/calendar.removeSubscription', { body: { id } }));
}

export async function refreshSubscription(id: string): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/calendar.refreshSubscription', { body: { id } }));
}

/* ───────────── Tags ───────────── */

export async function loadTags(): Promise<Tag[]> {
	return unwrap(await api.GET('/api/v1/calendar/tags'));
}

export async function updateTag(input: {
	name: string;
	newName?: string;
	color?: string;
}): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/calendar.updateTag', { body: input }));
}

export async function deleteTag(name: string): Promise<void> {
	unwrap(await api.POST('/api/v1/actions/calendar.deleteTag', { body: { name } }));
}
