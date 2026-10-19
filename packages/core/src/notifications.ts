import {
	type Actor,
	type Clock,
	type DbExecutor,
	defineAction,
	defineJob,
	defineRoute,
	type ExtensionContext,
	type FamilySettings,
	FamosError,
	type IdGenerator,
	type JobContext,
	type JobQueue,
	type Logger,
	type NotificationMessage,
	type NotifyRequest,
	NotifyRequestSchema,
	type NotifyWhen,
	NotifyWhenSchema,
	personPresent,
} from '@famos/sdk';
import {
	addDays,
	dateLocale,
	epochOf,
	formatClock,
	formatDate,
	formatTime,
	IsoTimeSchema,
	zoned,
} from '@famos/time';
import { z } from 'zod';
import type { Access } from './access.ts';
import { CORE_CAPABILITIES } from './core-capabilities.ts';
import { notificationCreated, notificationRead } from './core-events.ts';
import { stillWaiting, WAITING_KIND } from './draft-notices.ts';
import { type Features, ownerOf } from './features.ts';
import type { Registry } from './registry.ts';
import type { CoreTables, NotificationsTable } from './tables.ts';

/**
 * Notifications. `core.notify` writes one in-app row per recipient and enqueues one
 * `core.deliver` job per enabled, available channel; `core.deliver` renders the text in the
 * recipient's language, waits out quiet hours, and calls the channel. Titles and bodies are
 * family content: they are never logged.
 */
export type Translate = (locale: string, key: string, params?: Record<string, unknown>) => string;

export const defaultTranslate: Translate = (_locale, key) => key;

/** The words a key lists in every installed language (see `ExtensionContext.vocabulary`). */
export type Vocabulary = (key: string) => readonly string[];

export const noVocabulary: Vocabulary = () => [];

/* ───────────────────────── Preferences ───────────────────────── */

export const NotificationPrefsSchema = z.object({
	/** Per kind, per channel id: on or off. Missing entries follow the kind's defaults. */
	kinds: z.record(z.string(), z.record(z.string(), z.boolean())),
	/** No pushes in this window (family time zone); it may cross midnight. */
	quietHours: z.object({ start: IsoTimeSchema, end: IsoTimeSchema }).nullable(),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

const EMPTY_PREFS: NotificationPrefs = { kinds: {}, quietHours: null };

async function readPrefs(db: DbExecutor, memberId: string): Promise<NotificationPrefs> {
	const row = await db
		.withTables<CoreTables>()
		.selectFrom('core_notification_prefs')
		.select('prefs')
		.where('member_id', '=', memberId)
		.executeTakeFirst();
	if (!row) return EMPTY_PREFS;
	const parsed = NotificationPrefsSchema.safeParse(JSON.parse(row.prefs));
	return parsed.success ? parsed.data : EMPTY_PREFS;
}

/**
 * A way to reach people outside the app, as the delivery sees it: the host's own channels
 * (which need nothing of the job) and the installed extensions' (each bound to its extension's
 * own contexts, so its tables, secrets and network apply).
 */
export interface BoundChannel {
	readonly id: string;
	/** i18n key shown in preferences. */
	readonly label: string;
	/** i18n key for a member who cannot be reached through it, if any. */
	readonly hint?: string;
	/** Whether it is on for a kind that names no default channels. */
	readonly onByDefault: boolean;
	isAvailableFor(memberId: string): Promise<boolean>;
	send(ctx: JobContext, memberId: string, message: NotificationMessage): Promise<'sent' | 'gone'>;
}

/** Whether a channel is switched on for a kind: the member's choice, else the kind's default. */
function channelEnabled(
	prefs: NotificationPrefs,
	kind: { id: string; defaultChannels?: readonly string[] | undefined },
	channel: Pick<BoundChannel, 'id' | 'onByDefault'>,
): boolean {
	const chosen = prefs.kinds[kind.id]?.[channel.id];
	if (chosen !== undefined) return chosen;
	return defaultOn(kind, channel);
}

/** A kind that names its default channels decides alone; otherwise each channel says. */
const defaultOn = (
	kind: { defaultChannels?: readonly string[] | undefined },
	channel: Pick<BoundChannel, 'id' | 'onByDefault'>,
) => (kind.defaultChannels ? kind.defaultChannels.includes(channel.id) : channel.onByDefault);

const minutesOf = (time: string) => {
	const [h, m] = time.split(':');
	return Number(h) * 60 + Number(m);
};

/** When quiet hours end, if `now` is inside them (the window may cross midnight). */
export function quietUntil(
	quiet: NotificationPrefs['quietHours'],
	now: number,
	timeZone: string,
): number | null {
	if (!quiet) return null;
	const start = minutesOf(quiet.start);
	const end = minutesOf(quiet.end);
	if (start === end) return null;
	const local = zoned(now, timeZone);
	const minute = local.hour * 60 + local.minute;
	const crosses = start > end;
	const inside = crosses ? minute >= start || minute < end : minute >= start && minute < end;
	if (!inside) return null;
	const today = local.toPlainDate().toString();
	const endDate = crosses && minute >= start ? addDays(today, 1) : today;
	// Never schedule at or before now (a skipped hour on a DST day): that would loop.
	return Math.max(epochOf(endDate, quiet.end, timeZone), now + 60_000);
}

/* ───────────────────────── Producer side ───────────────────────── */

export interface Notifier {
	/** Validates a request and enqueues `core.notify` on `db` (pass the transaction in an action). */
	enqueue(db: DbExecutor, request: NotifyRequest): Promise<void>;
}

const NotifyPayloadSchema = NotifyRequestSchema.extend({
	/** Makes the job idempotent: a retried job never duplicates rows. */
	id: z.string(),
});

const DeliverPayloadSchema = z.object({ notificationId: z.string(), channel: z.string() });

export interface NotificationsDeps {
	db: DbExecutor;
	queue: JobQueue;
	clock: Clock;
	ids: IdGenerator;
	logger: Logger;
	/** The channels now: the host's, then those of the installed extensions that are on. */
	channels: () => readonly BoundChannel[];
	/** The family's public address, if it set one. */
	publicUrl?: string | undefined;
	translate: Translate;
	registry: () => Registry;
	access: () => Access;
	features: () => Features;
	/** Wakes the worker after jobs were enqueued outside a unit of work. */
	wake: () => void;
}

const ParamsSchema = z.record(z.string(), z.union([z.string(), z.number(), NotifyWhenSchema]));
type Region = Pick<FamilySettings, 'formatLocale' | 'hourCycle' | 'timeZone'>;

function writeWhen(when: NotifyWhen, locale: string, region: Region): string {
	if ('date' in when)
		return formatDate(when.date, locale, { day: 'numeric', month: 'short', year: 'numeric' });
	if ('time' in when) return formatClock(when.time, locale, region.hourCycle);
	return formatTime(when.at, when.timeZone ?? region.timeZone, locale, region.hourCycle);
}

/**
 * A stored text's parameters for one reader: its dates and times are written out only now, in
 * the reader's language with the family's region format, since readers may differ in language.
 */
function readParams(
	json: string | null,
	language: string,
	region: Region,
): Record<string, unknown> | undefined {
	if (json === null) return undefined;
	const locale = dateLocale(language, region.formatLocale, region.hourCycle);
	return Object.fromEntries(
		Object.entries(ParamsSchema.parse(JSON.parse(json))).map(([name, value]) => [
			name,
			typeof value === 'object' ? writeWhen(value, locale, region) : value,
		]),
	);
}

/** `path` on the family's public address, or null without one (or for something that is no path). */
export function absoluteLink(publicUrl: string | undefined, path: string | null): string | null {
	if (!publicUrl || !path?.startsWith('/') || path.startsWith('//')) return null;
	return `${publicUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Whether a channel can reach a member. A check that fails means "not available", logged
 * without details, and never stops the notification or the other channels.
 */
async function reachable(
	channel: BoundChannel,
	memberId: string,
	logger: Logger,
): Promise<boolean> {
	try {
		return await channel.isAvailableFor(memberId);
	} catch {
		logger.warn({ channel: channel.id, memberId }, 'notification channel check failed');
		return false;
	}
}

export function createNotifications(deps: NotificationsDeps) {
	const core = (db: DbExecutor) => db.withTables<CoreTables>();

	const notifier: Notifier = {
		async enqueue(db, request) {
			const parsed = NotifyRequestSchema.parse(request);
			if (!deps.registry().notificationKinds.has(parsed.kind))
				throw new Error(`Unknown notification kind "${parsed.kind}"`);
			if (parsed.to.capability && !deps.access().capability(parsed.to.capability))
				throw new Error(`Notification names unknown capability "${parsed.to.capability}"`);
			const now = deps.clock.now();
			await deps.queue.enqueue(
				db,
				'core.notify',
				{ ...parsed, id: deps.ids.next('notify') },
				{
					maxAttempts: notify.maxAttempts,
					runAt: now + (parsed.delayMs ?? 0),
					...(parsed.dedupeKey && { dedupeKey: `notify:${parsed.kind}:${parsed.dedupeKey}` }),
				},
			);
		},
	};

	/* ───────────── Jobs ───────────── */

	const notify = defineJob({
		name: 'core.notify',
		payload: NotifyPayloadSchema,
		async handle(ctx, request) {
			const kind = deps.registry().notificationKinds.get(request.kind);
			if (!kind) return;
			// A turned-off extension says nothing; no rows either.
			if (!deps.features().isOn(ownerOf(kind.id))) return;
			// Decided during the delay: there is nothing left to wait for.
			if (
				request.kind === WAITING_KIND &&
				request.dedupeKey &&
				!(await stillWaiting(ctx.db, request.dedupeKey))
			)
				return;

			const active = await ctx.family.members();
			const wanted = new Set<string>(request.to.members ?? []);
			if (request.to.capability) {
				for (const m of active)
					if (deps.access().effective(m.roleId).has(request.to.capability)) wanted.add(m.id);
			}
			if (request.to.except) wanted.delete(request.to.except);
			const recipients = active.filter((m) => wanted.has(m.id)).map((m) => m.id);
			if (recipients.length === 0) return;

			// Channel lookups touch other tables on the one connection: do them before the transaction.
			const plan = new Map<string, string[]>();
			const channels = deps.channels();
			for (const memberId of recipients) {
				const prefs = await readPrefs(ctx.db, memberId);
				const use: string[] = [];
				for (const channel of channels) {
					if (
						channelEnabled(prefs, kind, channel) &&
						(await reachable(channel, memberId, ctx.logger))
					)
						use.push(channel.id);
				}
				plan.set(memberId, use);
			}

			const dedupeKey = request.dedupeKey ?? `notify:${request.id}`;
			const created = await ctx.db.transaction().execute(async (trx) => {
				const made: string[] = [];
				for (const memberId of recipients) {
					const id = ctx.ids.next('notification');
					const row: NotificationsTable = {
						id,
						member_id: memberId,
						kind: request.kind,
						title_key: request.title.key,
						title_params: request.title.params ? JSON.stringify(request.title.params) : null,
						body_key: request.body?.key ?? null,
						body_params: request.body?.params ? JSON.stringify(request.body.params) : null,
						url: request.url ?? null,
						source_kind: request.source?.kind ?? null,
						source_id: request.source?.id ?? null,
						dedupe_key: dedupeKey,
						created_at: ctx.clock.now(),
						read_at: null,
					};
					const result = await core(trx)
						.insertInto('core_notifications')
						.values(row)
						.onConflict((oc) => oc.doNothing())
						.executeTakeFirst();
					if (Number(result.numInsertedOrUpdatedRows ?? 0) === 0) continue;
					made.push(memberId);
					for (const channel of plan.get(memberId) ?? []) {
						await deps.queue.enqueue(
							trx,
							'core.deliver',
							{ notificationId: id, channel },
							{ dedupeKey: `deliver:${id}:${channel}`, maxAttempts: deliver.maxAttempts },
						);
					}
				}
				return made;
			});
			for (const memberId of created) await ctx.events.emit(notificationCreated, { memberId });
			if (created.length > 0) deps.wake();
		},
	});

	const deliver = defineJob({
		name: 'core.deliver',
		payload: DeliverPayloadSchema,
		maxAttempts: 8,
		async handle(ctx, { notificationId, channel: channelId }) {
			const channel = deps.channels().find((c) => c.id === channelId);
			if (!channel) return;
			const row = await core(ctx.db)
				.selectFrom('core_notifications')
				.selectAll()
				.where('id', '=', notificationId)
				.executeTakeFirst();
			// Already seen in the app: a push would only repeat it.
			if (!row || row.read_at !== null) return;
			const member = await core(ctx.db)
				.selectFrom('core_members')
				.select(['locale', 'archived_at'])
				.where('id', '=', row.member_id)
				.executeTakeFirst();
			if (!member || member.archived_at !== null) return;
			// Things may have changed since it was queued: the feature turned off, the channel switched off.
			const kind = deps.registry().notificationKinds.get(row.kind);
			if (!kind || !deps.features().isOn(ownerOf(row.kind))) return;

			const family = await ctx.family.settings();
			const prefs = await readPrefs(ctx.db, row.member_id);
			if (!channelEnabled(prefs, kind, channel)) return;
			const until = quietUntil(prefs.quietHours, ctx.clock.now(), family.timeZone);
			if (until !== null) {
				await deps.queue.enqueue(
					ctx.db,
					'core.deliver',
					{ notificationId, channel: channelId },
					{
						runAt: until,
						dedupeKey: `deliver:${notificationId}:${channelId}:q${until}`,
						maxAttempts: deliver.maxAttempts,
					},
				);
				return;
			}

			const locale = member.locale ?? family.locale;
			const outcome = await channel.send(ctx, row.member_id, {
				title: deps.translate(locale, row.title_key, readParams(row.title_params, locale, family)),
				body: row.body_key
					? deps.translate(locale, row.body_key, readParams(row.body_params, locale, family))
					: null,
				url: row.url,
				link: absoluteLink(deps.publicUrl, row.url),
				tag: row.id,
				...(row.source_kind !== null &&
					row.source_id !== null && { source: { kind: row.source_kind, id: row.source_id } }),
			});
			if (outcome === 'gone')
				ctx.logger.info(
					{ channel: channelId, memberId: row.member_id },
					'notification channel gone',
				);
		},
	});

	/* ───────────── Actions ───────────── */

	const requireMember = (actor: Actor) => {
		if (!personPresent(actor)) throw new FamosError('forbidden', 'Only members can do this');
		return actor.memberId;
	};

	const roleOf = (actor: Actor) => (actor.kind === 'member' ? actor.roleId : '');

	const markRead = defineAction({
		id: 'core.markNotificationsRead',
		title: 'Mark notifications as read',
		input: z.object({ ids: z.array(z.string()).max(500).optional() }),
		output: z.object({ ok: z.literal(true) }),
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		approval: 'never',
		async run(uow, input) {
			const memberId = requireMember(uow.actor);
			if (input.ids?.length === 0) return { ok: true as const };
			let q = core(uow.db)
				.updateTable('core_notifications')
				.set({ read_at: uow.clock.now() })
				.where('member_id', '=', memberId)
				.where('read_at', 'is', null);
			if (input.ids) q = q.where('id', 'in', input.ids);
			const result = await q.executeTakeFirst();
			if (Number(result.numUpdatedRows) > 0) uow.emit(notificationRead, { memberId });
			return { ok: true as const };
		},
	});

	const setPreferences = defineAction({
		id: 'core.setNotificationPreferences',
		title: 'Choose how to be notified',
		// Kinds are merged per kind (a kind not sent keeps its choice); quiet hours are replaced.
		input: NotificationPrefsSchema,
		output: NotificationPrefsSchema,
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		approval: 'never',
		async run(uow, input) {
			const memberId = requireMember(uow.actor);
			const known = deps.registry().notificationKinds;
			const held = deps.access().effective(roleOf(uow.actor));
			for (const kindId of Object.keys(input.kinds)) {
				const kind = known.get(kindId);
				if (!kind) throw new FamosError('bad_request', `Unknown notification kind "${kindId}"`);
				if (kind.audience && !held.has(kind.audience))
					throw new FamosError(
						'bad_request',
						`Notification kind "${kindId}" is not available to you`,
					);
			}
			const current = await readPrefs(uow.db, memberId);
			const next: NotificationPrefs = {
				kinds: { ...current.kinds, ...input.kinds },
				quietHours: input.quietHours,
			};
			const value = JSON.stringify(next);
			const now = uow.clock.now();
			await core(uow.db)
				.insertInto('core_notification_prefs')
				.values({ member_id: memberId, prefs: value, updated_at: now })
				.onConflict((oc) => oc.column('member_id').doUpdateSet({ prefs: value, updated_at: now }))
				.execute();
			return next;
		},
	});

	/* ───────────── Routes ───────────── */

	const NotificationViewSchema = z.object({
		id: z.string(),
		kind: z.string(),
		/** Rendered in the member's language. */
		title: z.string(),
		body: z.string().nullable(),
		/** A path inside the app. */
		url: z.string().nullable(),
		createdAt: z.number(),
		read: z.boolean(),
	});

	const memberLocale = async (ctx: ExtensionContext, memberId: string) => {
		const member = await core(ctx.db)
			.selectFrom('core_members')
			.select('locale')
			.where('id', '=', memberId)
			.executeTakeFirst();
		return member?.locale ?? (await ctx.family.settings()).locale;
	};

	const listNotifications = defineRoute({
		method: 'get',
		path: '/notifications',
		operationId: 'core.listNotifications',
		summary: "The signed-in member's notifications, newest first, with the unread count",
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
		response: z.object({ unread: z.number().int(), items: z.array(NotificationViewSchema) }),
		async handle(ctx, { query, actor }) {
			const memberId = requireMember(actor);
			const locale = await memberLocale(ctx, memberId);
			const family = await ctx.family.settings();
			const rows = await core(ctx.db)
				.selectFrom('core_notifications')
				.selectAll()
				.where('member_id', '=', memberId)
				.orderBy('created_at', 'desc')
				.orderBy('id', 'desc')
				.limit(query?.limit ?? 50)
				.execute();
			const unread = await core(ctx.db)
				.selectFrom('core_notifications')
				.select((eb) => eb.fn.countAll<number>().as('n'))
				.where('member_id', '=', memberId)
				.where('read_at', 'is', null)
				.executeTakeFirstOrThrow();
			return {
				unread: Number(unread.n),
				items: rows.map((r) => ({
					id: r.id,
					kind: r.kind,
					title: deps.translate(locale, r.title_key, readParams(r.title_params, locale, family)),
					body: r.body_key
						? deps.translate(locale, r.body_key, readParams(r.body_params, locale, family))
						: null,
					url: r.url,
					createdAt: r.created_at,
					read: r.read_at !== null,
				})),
			};
		},
	});

	const getPreferences = defineRoute({
		method: 'get',
		path: '/notifications/preferences',
		operationId: 'core.getNotificationPreferences',
		summary: 'Notification kinds and channels, and how the signed-in member set them',
		requires: CORE_CAPABILITIES.notificationsReceive.id,
		response: z.object({
			kinds: z.array(
				z.object({
					id: z.string(),
					/** Translated. */
					label: z.string(),
					/** Channel ids on by default. */
					defaultChannels: z.array(z.string()),
				}),
			),
			channels: z.array(
				z.object({
					id: z.string(),
					label: z.string(),
					available: z.boolean(),
					/** What to do when the member cannot be reached through it, if the channel says. */
					hint: z.string().optional(),
				}),
			),
			prefs: NotificationPrefsSchema,
		}),
		async handle(ctx, { actor }) {
			const memberId = requireMember(actor);
			const locale = await memberLocale(ctx, memberId);
			const features = deps.features();
			const held = deps.access().effective(roleOf(actor));
			const channels = deps.channels();
			return {
				kinds: [...deps.registry().notificationKinds.values()]
					.filter((k) => features.isOn(ownerOf(k.id)))
					.filter((k) => !k.audience || held.has(k.audience))
					.map((k) => ({
						id: k.id,
						label: deps.translate(locale, k.label),
						defaultChannels: k.defaultChannels
							? [...k.defaultChannels]
							: channels.filter((c) => c.onByDefault).map((c) => c.id),
					})),
				channels: await Promise.all(
					channels.map(async (c) => {
						const available = await reachable(c, memberId, ctx.logger);
						return {
							id: c.id,
							label: deps.translate(locale, c.label),
							available,
							...(!available && c.hint && { hint: deps.translate(locale, c.hint) }),
						};
					}),
				),
				prefs: await readPrefs(ctx.db, memberId),
			};
		},
	});

	return {
		notifier,
		jobs: [notify, deliver],
		actions: [markRead, setPreferences],
		routes: [listNotifications, getPreferences],
	};
}
