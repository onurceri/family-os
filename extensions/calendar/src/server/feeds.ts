import { createHash, randomBytes } from 'node:crypto';
import {
	assertFullSignIn,
	credentialOwner,
	defineAction,
	defineRoute,
	FamosError,
	type JobContext,
	personPresent,
	type RestoreContext,
	selfOf,
	systemActor,
	TextResponseSchema,
} from '@famos/sdk';
import { DAY_MS, HOUR_MS, todayIn } from '@famos/time';
import { z } from 'zod';
import {
	CreatedFeedSchema,
	CreateFeedInputSchema,
	type Feed,
	FeedIdSchema,
	FeedSchema,
} from '../contract/index.ts';
import { calendarManage, calendarView } from './capabilities.ts';
import { buildCalendar } from './ics.ts';
import { type EventRow, events, type FeedRow } from './store.ts';

/**
 * Secret ICS feeds out. The address holds a long random token; only its hash is stored,
 * so a copied database cannot reveal working addresses. Whoever has the address sees the events.
 */

/** Feeds carry events from this long ago onward. */
const WINDOW_DAYS = 90;
/** `last_used_at` is refreshed at most this often. */
const TOUCH_EVERY_MS = HOUR_MS;
const HEX = /^[0-9a-f]{64}$/;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const feedPath = (token: string) => `/api/v1/calendar/feed/${token}.ics`;

export function toFeed(row: FeedRow): Feed {
	return {
		id: row.id,
		scope: row.scope,
		includeNotes: row.include_notes === 1,
		label: row.label,
		createdBy: row.created_by,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	};
}

export const createFeed = defineAction({
	id: 'calendar.createFeed',
	title: 'Create a secret calendar address for phones and other calendars',
	input: CreateFeedInputSchema,
	output: CreatedFeedSchema,
	requires: calendarView.id,
	approval: 'never',
	// The address shows the household's events to whoever holds it: never for the AI.
	external: true,
	async run(uow, input) {
		// The address works anywhere, for months: only a password sign-in may make one, never a PIN.
		assertFullSignIn(uow.actor);
		// Your own events need only the right to see the calendar; the whole family's, the right to manage.
		if (input.scope === 'family') {
			if (!uow.can(calendarManage.id)) throw new FamosError('forbidden', 'Not allowed');
		} else if (input.scope !== uow.actor.memberId) {
			throw new FamosError('forbidden', 'A feed can only be for yourself or the whole family');
		}
		const token = randomBytes(32).toString('base64url');
		const row: FeedRow = {
			id: uow.ids.next('cal_feed'),
			token_hash: hashToken(token),
			scope: input.scope,
			include_notes: input.includeNotes ? 1 : 0,
			label: input.label || null,
			created_by: uow.actor.memberId,
			created_at: uow.clock.now(),
			last_used_at: null,
			revoked_at: null,
		};
		await events(uow.db).insertInto('calendar_feeds').values(row).execute();
		return { feed: toFeed(row), token, path: feedPath(token) };
	},
});

export const revokeFeed = defineAction({
	id: 'calendar.revokeFeed',
	title: 'Stop a secret calendar address from working',
	input: z.object({ id: FeedIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	requires: calendarView.id,
	approval: 'never',
	async run(uow, { id }) {
		const row = await events(uow.db)
			.selectFrom('calendar_feeds')
			.select(['id', 'created_by'])
			.where('id', '=', id)
			.where('revoked_at', 'is', null)
			.executeTakeFirst();
		const self = selfOf(uow.actor);
		const own = self !== null && row?.created_by === self;
		if (!row || !(own || uow.can(calendarManage.id)))
			throw new FamosError('not_found', 'Feed not found');
		await events(uow.db)
			.updateTable('calendar_feeds')
			.set({ revoked_at: uow.clock.now() })
			.where('id', '=', id)
			.execute();
		return { ok: true as const };
	},
});

/** Records that a feed was fetched. A system step run by the public feed route, at most hourly. */
export const touchFeed = defineAction({
	id: 'calendar.touchFeed',
	title: 'Note that a calendar address was used',
	expose: 'internal',
	input: z.object({ id: FeedIdSchema }),
	output: z.object({ ok: z.literal(true) }),
	requires: calendarManage.id,
	approval: 'never',
	async run(uow, { id }) {
		const now = uow.clock.now();
		await events(uow.db)
			.updateTable('calendar_feeds')
			.set({ last_used_at: now })
			.where('id', '=', id)
			.where((eb) =>
				eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', now - TOUCH_EVERY_MS)]),
			)
			.execute();
		return { ok: true as const };
	},
});

export const listFeeds = defineRoute({
	method: 'get',
	path: '/feeds',
	operationId: 'calendar.listFeeds',
	summary: 'Secret calendar addresses you created (all of them for managers); never the addresses',
	requires: calendarView.id,
	response: z.array(FeedSchema),
	async handle(ctx, { actor }) {
		if (!personPresent(actor)) return [];
		const all = ctx.access.can(actor, calendarManage.id);
		let query = events(ctx.db)
			.selectFrom('calendar_feeds')
			.selectAll()
			.where('revoked_at', 'is', null);
		if (!all) query = query.where('created_by', '=', actor.memberId);
		return (await query.orderBy('created_at', 'desc').execute()).map(toFeed);
	},
});

/** Whether a row belongs in a feed of this scope. */
const inScope = (row: EventRow, scope: string) => {
	if (scope === 'family') return true;
	const members = JSON.parse(row.member_ids) as string[];
	return members.length === 0 || members.includes(scope);
};

export const feedRoute = defineRoute({
	method: 'get',
	path: '/feed/{file}',
	operationId: 'calendar.getFeed',
	summary: 'An ICS feed of the family calendar; the secret address is the credential',
	requires: 'public',
	params: z.object({ file: z.string().max(200) }),
	response: TextResponseSchema,
	async handle(ctx, { params }) {
		const token = params.file.endsWith('.ics') ? params.file.slice(0, -4) : null;
		const hash = token ? hashToken(token) : null;
		const feed =
			hash && HEX.test(hash)
				? await events(ctx.db)
						.selectFrom('calendar_feeds')
						.selectAll()
						.where('token_hash', '=', hash)
						.where('revoked_at', 'is', null)
						.executeTakeFirst()
				: undefined;
		if (!feed) throw new FamosError('not_found', 'Not found');
		// The address acts for the member who made it, as they are today: gone, archived or no longer
		// allowed to see (or, for the whole family's, manage) the calendar, it answers as if unknown.
		const owner = feed.created_by
			? await credentialOwner(
					ctx,
					feed.created_by,
					feed.scope === 'family' ? calendarManage.id : calendarView.id,
				)
			: null;
		if (!owner) throw new FamosError('not_found', 'Not found');

		const now = ctx.clock.now();
		if (feed.last_used_at === null || now - feed.last_used_at >= TOUCH_EVERY_MS)
			// Bookkeeping by the server itself; the caller is anonymous and may change nothing.
			await ctx.actions.invoke('calendar.touchFeed', { id: feed.id }, systemActor('calendar.feed'));

		const cutoff = now - WINDOW_DAYS * DAY_MS;
		const { timeZone } = await ctx.family.settings();
		const cutoffDate = todayIn(timeZone, cutoff);
		const rows = await events(ctx.db)
			.selectFrom('calendar_events')
			.selectAll()
			.where('deleted_at', 'is', null)
			.where((eb) =>
				eb.or([
					eb('rrule', 'is not', null),
					eb.and([eb('all_day', '=', 0), eb('ends_at', '>=', cutoff)]),
					eb.and([eb('all_day', '=', 1), eb('end_date', '>=', cutoffDate)]),
				]),
			)
			.orderBy('created_at')
			.execute();

		const members = await ctx.family.members();
		const name =
			feed.scope === 'family'
				? 'FamilyOS'
				: `FamilyOS · ${members.find((m) => m.id === feed.scope)?.displayName ?? ''}`.trim();
		return {
			text: buildCalendar(
				name,
				rows.filter((row) => inScope(row, feed.scope)),
				{ includeNotes: feed.include_notes === 1, now },
			),
			contentType: 'text/calendar; charset=utf-8',
			cacheControl: 'private, max-age=300',
		};
	},
});

/**
 * Stops every address a member made, when their sign-ins end (signed out everywhere, new password,
 * archived). Core retries it until it succeeds; stopping an address twice changes nothing.
 */
export async function endFeedsOf(ctx: JobContext, memberId: string): Promise<void> {
	await events(ctx.db)
		.updateTable('calendar_feeds')
		.set({ revoked_at: ctx.clock.now() })
		.where('created_by', '=', memberId)
		.where('revoked_at', 'is', null)
		.execute();
}

/**
 * After a restore: addresses stopped since the backup stay stopped. Only addresses the backup also
 * holds are matched, by id, and nothing is ever started again.
 */
export async function carryStoppedFeeds(ctx: RestoreContext): Promise<number> {
	if (!ctx.previous) return 0;
	const stopped = await events(ctx.previous)
		.selectFrom('calendar_feeds')
		.select(['id', 'revoked_at'])
		.where('revoked_at', 'is not', null)
		.execute();
	let carried = 0;
	for (const feed of stopped) {
		const result = await events(ctx.db)
			.updateTable('calendar_feeds')
			.set({ revoked_at: feed.revoked_at ?? ctx.clock.now() })
			.where('id', '=', feed.id)
			.where('revoked_at', 'is', null)
			.executeTakeFirst();
		carried += Number(result.numUpdatedRows);
	}
	return carried;
}
