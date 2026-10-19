import { idSchema, wholeRecord } from '@famos/sdk';
import { IsoDateSchema, IsoTimeSchema, RecurrenceSchema } from '@famos/time';
import { z } from 'zod';

/**
 * Calendar contract: shared by the server, the web UI and other extensions.
 * Dates and times are local to the family time zone; the server stores instants.
 */
export const EventIdSchema = idSchema('cal_event');
export const MemberIdSchema = idSchema('member');

/**
 * Reminder presets, in minutes before the start. For all-day events the reference is 09:00 local
 * time on the day: 0 = 09:00 that day, 720 = 21:00 the evening before.
 */
export const TIMED_REMINDERS = [0, 5, 10, 15, 30, 60, 120, 1440] as const;
export const ALL_DAY_REMINDERS = [0, 720] as const;
/** What an event gets when no reminder was chosen. */
export const defaultReminder = (allDay: boolean) => (allDay ? 0 : 30);

/* ───────────── Tags ───────────── */

export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 24;

/** The identity of a tag: case-insensitive (also Turkish I/ı/İ) with spacing collapsed. */
export const tagKey = (name: string): string =>
	name
		.trim()
		.replace(/\s+/g, ' ')
		.toLowerCase()
		.replace(/ı/g, 'i')
		.replace(/\u0307/g, '');

/**
 * Cleans a list of tags: trimmed, spacing collapsed, cut to the length limit, case-insensitive
 * duplicates dropped (the first spelling wins), at most `MAX_TAGS`. Lenient on purpose: it is used
 * for feeds from other apps as well as for what the family types.
 */
export function normalizeTags(raw: readonly string[] | null | undefined): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw ?? []) {
		const name = item.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH).trim();
		const key = tagKey(name);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(name);
		if (out.length === MAX_TAGS) break;
	}
	return out;
}

const TagName = z.string().trim().min(1).max(MAX_TAG_LENGTH);

/**
 * Tells the reviewer which event it is. For an AI it is the guard against acting on the wrong
 * one: the person's own words, which must name the target. The runner stores the real title
 * here on every draft.
 */
export const ReviewLabelSchema = z
	.string()
	.trim()
	.max(200)
	.optional()
	.describe(
		'Required for you: the name the person used for this event, in their words, not the listed title. If no listed event fits those words, do not call this tool: tell the person it is not on the calendar.',
	);

export const EventInputSchema = z
	.object({
		title: z.string().trim().min(1).max(120).describe('Short title, e.g. "Zoo trip"'),
		allDay: z.boolean().default(false).describe('True when the event has no time of day'),
		date: IsoDateSchema.describe('Start date, YYYY-MM-DD, in the family time zone'),
		endDate: IsoDateSchema.optional().describe('Last day of a multi-day all-day event (inclusive)'),
		startTime: IsoTimeSchema.optional().describe('Start time HH:MM; required unless allDay'),
		endTime: IsoTimeSchema.optional().describe(
			'End time HH:MM; defaults to one hour after the start. Earlier than the start means the next day.',
		),
		memberIds: z
			.array(MemberIdSchema)
			.default([])
			.describe('Family members involved; empty means the whole family'),
		location: z.string().trim().max(200).optional(),
		notes: z.string().trim().max(2000).optional(),
		recurrence: RecurrenceSchema.optional().describe('Repeat rule; omit for a one-off event'),
		reminder: z
			.number()
			.int()
			.nullable()
			.optional()
			.describe(
				'Reminder in minutes before the start (timed: 0, 5, 10, 15, 30, 60, 120, 1440; all-day: 0 = 09:00 that day, 720 = 21:00 the evening before); null for none; omit for the default',
			),
		tags: z
			.array(TagName)
			.max(MAX_TAGS)
			.optional()
			.describe(
				"Short labels. Reuse one of the family's existing tags when it fits instead of inventing a new one; at most 2.",
			),
	})
	.superRefine((v, ctx) => {
		if (v.reminder !== null && v.reminder !== undefined) {
			const allowed: readonly number[] = v.allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS;
			if (!allowed.includes(v.reminder))
				ctx.addIssue({ code: 'custom', path: ['reminder'], message: 'Unsupported reminder' });
		}
		if (!v.allDay && !v.startTime)
			ctx.addIssue({ code: 'custom', path: ['startTime'], message: 'Start time is required' });
		if (v.endDate && v.endDate < v.date)
			ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date is before the start' });
		// An end earlier than the start is the next morning; the same time would be no length at all.
		if (!v.allDay && v.startTime && v.endTime && v.endTime === v.startTime) {
			ctx.addIssue({
				code: 'custom',
				path: ['endTime'],
				message: 'End time must differ from the start time',
			});
		}
	});
export type EventInput = z.input<typeof EventInputSchema>;

/**
 * The whole event as the form saves it: every field, null for one left empty (a null reminder
 * is no reminder).
 */
export const EventReplaceSchema = wholeRecord(EventInputSchema);
export type EventReplace = z.input<typeof EventReplaceSchema>;

/** The event a whole replacement describes, with its empty fields left out. */
export function eventFromReplace(event: EventReplace): EventInput {
	const { endDate, startTime, endTime, location, notes, recurrence, tags, ...rest } = event;
	return {
		...rest,
		...(endDate !== null && { endDate }),
		...(startTime !== null && { startTime }),
		...(endTime !== null && { endTime }),
		...(location !== null && { location }),
		...(notes !== null && { notes }),
		...(recurrence !== null && { recurrence }),
		...(tags !== null && { tags }),
	};
}

/** A timed event whose end time is earlier than its start ends the next day (an overnight event). */
export const endsNextDay = (
	startTime: string | null | undefined,
	endTime: string | null | undefined,
) => Boolean(startTime && endTime && endTime < startTime);

export const EventDetailSchema = z.object({
	id: z.string(),
	/** Counts every write of the event; a caller names it to change the event only if it is unchanged. */
	version: z.number().int(),
	title: z.string(),
	allDay: z.boolean(),
	date: z.string(),
	endDate: z.string().nullable(),
	startTime: z.string().nullable(),
	endTime: z.string().nullable(),
	memberIds: z.array(z.string()),
	location: z.string().nullable(),
	notes: z.string().nullable(),
	recurrence: RecurrenceSchema.nullable(),
	/** Minutes before the start (see `EventInputSchema`); null = no reminder. Defaults resolved. */
	reminder: z.number().nullable(),
	/** Raw RRULE when the rule is outside the editable presets. */
	rrule: z.string().nullable(),
	tags: z.array(z.string()),
	/** A date moved out of a repeating event: the series it belongs to and the date it replaced. */
	seriesId: z.string().optional(),
	/** With `seriesId`: the replaced occurrence's key, as in `Occurrence.key` of the series. */
	recurrenceKey: z.string().optional(),
});
export type EventDetail = z.infer<typeof EventDetailSchema>;

export const FeedIdSchema = idSchema('cal_feed');
export const SubscriptionIdSchema = idSchema('cal_sub');

/** Where an occurrence comes from when it is not one of the family's own events. */
export const OccurrenceSourceSchema = z.object({
	kind: z.literal('subscription'),
	id: z.string(),
	name: z.string(),
	/** `#rrggbb`. */
	color: z.string(),
});
export type OccurrenceSource = z.infer<typeof OccurrenceSourceSchema>;

/** One occurrence of an event in a range (recurring events expanded). */
export const OccurrenceSchema = z.object({
	/** The family event, or `<subscription id>:<uid>:<recurrence>` for an external one. */
	eventId: z.string(),
	/** Identifies this occurrence for deletion: epoch ms (timed) or YYYY-MM-DD (all-day). */
	key: z.string(),
	title: z.string(),
	allDay: z.boolean(),
	/** Timed events: instants (epoch ms). */
	start: z.number().nullable(),
	end: z.number().nullable(),
	/** All-day events: inclusive dates. */
	startDate: z.string().nullable(),
	endDate: z.string().nullable(),
	memberIds: z.array(z.string()),
	location: z.string().nullable(),
	recurring: z.boolean(),
	/** External events carry their notes; a family event's notes come only to the AI's reads. */
	notes: z.string().nullable(),
	/** Null for the family's own events. */
	source: OccurrenceSourceSchema.nullable(),
	/** False for subscription events: they cannot be changed here. */
	editable: z.boolean(),
	/** Tags of the event (a subscription event keeps the ones its feed names). */
	tags: z.array(z.string()),
	/** A date moved out of a repeating event: the series it belongs to (its `eventId` is its own). */
	seriesId: z.string().optional(),
	/** With `seriesId`: the key the series' occurrence had (what it replaced). */
	recurrenceKey: z.string().optional(),
});
export type Occurrence = z.infer<typeof OccurrenceSchema>;

export const RangeQuerySchema = z
	.object({ from: IsoDateSchema, to: IsoDateSchema })
	.refine((r) => r.from <= r.to, { message: '`from` must not be after `to`' });

export const eventChangedPayload = z.object({
	eventId: z.string(),
	/** `delete`: the event is gone for readers (removed, or a moved date put back). */
	op: z.enum(['upsert', 'delete']).optional(),
});

/* ───────────── Feeds out: a secret ICS address per family or member ───────────── */

/** `family` (every event) or a member id (their events plus whole-family events). */
export const FeedScopeSchema = z.union([z.literal('family'), MemberIdSchema]);

export const CreateFeedInputSchema = z.object({
	scope: FeedScopeSchema,
	includeNotes: z.boolean().default(false).describe('Whether event notes appear in the feed'),
	label: z.string().trim().max(60).optional().describe('Where it is used, e.g. "Mum\'s phone"'),
});

export const FeedSchema = z.object({
	id: z.string(),
	scope: z.string(),
	includeNotes: z.boolean(),
	label: z.string().nullable(),
	createdBy: z.string().nullable(),
	createdAt: z.number(),
	lastUsedAt: z.number().nullable(),
});
export type Feed = z.infer<typeof FeedSchema>;

/** The token is shown exactly once: only its hash is stored. */
export const CreatedFeedSchema = z.object({
	feed: FeedSchema,
	token: z.string(),
	/** Path of the feed on this server; the browser adds the origin. */
	path: z.string(),
});

/* ───────────── Subscriptions in: read-only external calendars ───────────── */

/** The colours offered for a subscription: the family's member palette (core's `MEMBER_COLORS`). */
export const SUBSCRIPTION_COLORS = [
	'#3d7aae',
	'#c38f22',
	'#975cbd',
	'#2f9a94',
	'#c66591',
	'#68778b',
	'#996c46',
	'#5c923d',
] as const;

const SubscriptionName = z.string().trim().min(1).max(80);
const SubscriptionColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** `https:` or `webcal:`; the address is a credential and is stored sealed. */
const SubscriptionUrl = z
	.string()
	.trim()
	.max(2000)
	.refine((v) => /^(https|webcals?):\/\/[^\s/]+/i.test(v), 'Expected an https: or webcal: address');

export const AddSubscriptionInputSchema = z.object({
	name: SubscriptionName.describe('Shown next to its events, e.g. "School"'),
	url: SubscriptionUrl,
	color: SubscriptionColor.optional(),
	memberIds: z.array(MemberIdSchema).default([]).describe('Whom it concerns; empty = everyone'),
	reminders: z.boolean().default(false),
	allowLocal: z.boolean().default(false).describe('Allow an address on the home network'),
});

export const UpdateSubscriptionInputSchema = z.object({
	id: SubscriptionIdSchema,
	name: SubscriptionName.optional(),
	/** Replaces the address (and forgets what was cached from the old one). */
	url: SubscriptionUrl.optional(),
	color: SubscriptionColor.optional(),
	memberIds: z.array(MemberIdSchema).optional(),
	reminders: z.boolean().optional(),
	allowLocal: z.boolean().optional(),
});

export const SUBSCRIPTION_ERRORS = [
	'unreachable',
	'too_large',
	'not_calendar',
	'blocked_address',
	'bad_url',
] as const;

export const SubscriptionSchema = z.object({
	id: z.string(),
	name: z.string(),
	/** Host name only: the full address is a secret and never leaves the server. */
	host: z.string(),
	color: z.string(),
	memberIds: z.array(z.string()),
	reminders: z.boolean(),
	allowLocal: z.boolean(),
	lastFetchedAt: z.number().nullable(),
	/** A code (`unreachable`, `too_large`, `not_calendar`, `blocked_address`, `http_<status>`), or null. */
	lastError: z.string().nullable(),
	eventCount: z.number(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/* ───────────── Tag list: colours and housekeeping ───────────── */

export const TagSchema = z.object({
	name: z.string(),
	/** `#rrggbb`, from the family palette. */
	color: z.string(),
});
export type Tag = z.infer<typeof TagSchema>;

export const UpdateTagInputSchema = z.object({
	name: z.string().trim().min(1).max(MAX_TAG_LENGTH).describe('The tag as it is now'),
	newName: TagName.optional().describe(
		'Renames the tag on every event; merges into a tag that exists',
	),
	color: SubscriptionColor.optional(),
});

export const DeleteTagInputSchema = z.object({
	name: z.string().trim().min(1).max(MAX_TAG_LENGTH),
});

/** Where the app opens an event: the calendar on its day, with the event's details beside it. */
export const eventHref = (eventId: string, date: string) => `/calendar?event=${eventId}&on=${date}`;
