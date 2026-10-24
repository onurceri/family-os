import {
	type Actor,
	type AudienceTarget,
	type Clock,
	DAY_MS,
	type DbExecutor,
	defineJob,
	type EventDefinition,
	type ExtensionContext,
	FamosError,
	memberBehind,
} from '@famos/sdk';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Access } from './access.ts';
import { audienceOf, inAudience } from './event-audience.ts';
import type { CoreTables } from './tables.ts';

/** The change log is kept this long; a client away for longer starts over with a full read. */
export const CHANGES_KEEP_MS = 30 * DAY_MS;
/** Rows read at once; a client asks again from the cursor when `more` is set. */
export const CHANGES_PAGE = 500;

const table = (db: DbExecutor) => db.withTables<CoreTables>();

type NewChange = {
	extension: string;
	entity: string;
	entity_id: string;
	op: 'upsert' | 'delete';
	audience: string;
};

/**
 * Writes the log rows of the events a transaction emitted, in that transaction. An event that
 * names no things (`changes` absent) leaves nothing. Two events about the same thing collapse to
 * the later one, so a burst of edits is one row.
 */
export async function recordChanges(
	db: DbExecutor,
	definitions: ReadonlyMap<string, EventDefinition>,
	now: number,
	events: readonly (readonly [string, unknown])[],
): Promise<void> {
	const rows = new Map<string, NewChange>();
	for (const [name, payload] of events) {
		const definition = definitions.get(name);
		if (!definition?.changes) continue;
		const audience = JSON.stringify(audienceOf(definition, name, payload));
		const extension = name.split('.')[0] ?? name;
		for (const change of definition.changes(payload)) {
			const key = `${extension}\u0000${change.entity}\u0000${change.id}`;
			// Set again so the later change also comes later in the log.
			rows.delete(key);
			rows.set(key, {
				extension,
				entity: change.entity,
				entity_id: change.id,
				op: change.op,
				audience,
			});
		}
	}
	for (const row of rows.values())
		await table(db)
			.insertInto('core_changes')
			.values({ at: now, ...row })
			.execute();
}

export interface ChangeEntry {
	seq: number;
	at: number;
	extension: string;
	entity: string;
	id: string;
	op: 'upsert' | 'delete';
}

export interface ChangesPage {
	/** The things that changed for this actor, once each, in log order. */
	changes: ChangeEntry[];
	/** Where to read from next: the last row looked at, whether the actor may hear it or not. */
	cursor: number;
	/** More rows follow the cursor. */
	more: boolean;
}

export interface ChangesReader {
	/** The newest seq in the log (0 before the first change). */
	head(db?: DbExecutor): Promise<number>;
	/**
	 * What changed after `since`, for this actor: rows whose audience does not include them are
	 * left out. A cursor from before the oldest kept row (or from a log that has since been
	 * restored to an earlier state) is `gone`: the client reads everything again.
	 */
	since(
		since: number,
		actor: Actor,
		options?: { extension?: string; limit?: number },
	): Promise<ChangesPage>;
	/**
	 * A validator for one extension's collection as this actor sees it: it changes when the log
	 * has a newer row for the extension, when the actor's capabilities in it differ, or when the
	 * window (the range or "today" a list is cut by) differs. A view that changes without a
	 * write, as a day passes or a role changes, therefore changes the tag too.
	 */
	collectionTag(extension: string, actor: Actor, window?: string): Promise<string>;
}

/** Whether an actor hears of a row: the event audience, checked as the realtime hub checks it. */
function hears(
	access: Pick<Access, 'can' | 'capability'>,
	actor: Actor,
	targets: readonly AudienceTarget[],
): boolean {
	if (actor.kind === 'member' || actor.kind === 'display')
		return inAudience(access, actor, targets);
	if (actor.kind === 'system') return true;
	// An app or an agent hears what the person it works for would hear, within its own limits.
	const member = memberBehind(actor);
	return targets.some((target) => {
		if (typeof target === 'string') return !!access.capability(target) && access.can(actor, target);
		if ('everyone' in target) return true;
		if ('anyMember' in target) return member !== null;
		if ('member' in target) return member === target.member;
		return false;
	});
}

/** A 53-bit string hash (cyrb53): a validator for caches, not a secret. */
function hash(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function createChanges(deps: {
	db: DbExecutor;
	clock: Clock;
	access: () => Access;
}): ChangesReader {
	async function head(db: DbExecutor = deps.db): Promise<number> {
		// AUTOINCREMENT remembers the highest seq even after every row was pruned.
		const result = await sql<{
			seq: number;
		}>`select seq from sqlite_sequence where name = 'core_changes'`.execute(db);
		return result.rows[0]?.seq ?? 0;
	}

	return {
		head,
		async since(since, actor, options = {}) {
			const limit = Math.min(options.limit ?? CHANGES_PAGE, CHANGES_PAGE);
			const [oldest, newest] = await Promise.all([
				table(deps.db)
					.selectFrom('core_changes')
					.select((eb) => eb.fn.min('seq').as('seq'))
					.executeTakeFirst(),
				head(),
			]);
			// Rows between the cursor and the oldest one kept were pruned; a cursor ahead of the
			// log belongs to another history.
			const floor = oldest?.seq ?? newest + 1;
			if (since < 0 || since > newest || since + 1 < floor)
				throw new FamosError(
					'gone',
					'The changes since then are no longer kept. Read everything again.',
				);
			let query = table(deps.db)
				.selectFrom('core_changes')
				.selectAll()
				.where('seq', '>', since)
				.orderBy('seq')
				.limit(limit + 1);
			if (options.extension) query = query.where('extension', '=', options.extension);
			const raw = await query.execute();
			const more = raw.length > limit;
			const rows = raw.slice(0, limit);
			const access = deps.access();
			const latest = new Map<string, ChangeEntry>();
			for (const row of rows) {
				let targets: AudienceTarget[] = [];
				try {
					targets = JSON.parse(row.audience) as AudienceTarget[];
				} catch {
					// An unreadable audience is nobody.
				}
				if (!hears(access, actor, targets)) continue;
				const key = `${row.extension}\u0000${row.entity}\u0000${row.entity_id}`;
				latest.delete(key);
				latest.set(key, {
					seq: row.seq,
					at: row.at,
					extension: row.extension,
					entity: row.entity,
					id: row.entity_id,
					op: row.op,
				});
			}
			return {
				changes: [...latest.values()],
				cursor: rows.at(-1)?.seq ?? since,
				more,
			};
		},
		async collectionTag(extension, actor, window = '') {
			const last = await table(deps.db)
				.selectFrom('core_changes')
				.select((eb) => eb.fn.max('seq').as('seq'))
				.where('extension', '=', extension)
				.executeTakeFirst();
			const access = deps.access();
			const caps = access.capabilities
				.filter((c) => c.id.startsWith(`${extension}.`) && access.can(actor, c.id))
				.map((c) => c.id)
				.toSorted();
			return hash(`${last?.seq ?? 0}|${caps.join(',')}|${window}`);
		},
	};
}

export const PRUNE_CHANGES_JOB = 'core.pruneChanges';

/** Removes log rows older than the retention once a day; keeps itself scheduled. */
export const pruneChanges = defineJob({
	name: PRUNE_CHANGES_JOB,
	payload: z.object({}),
	maxAttempts: 3,
	async handle(ctx) {
		const now = ctx.clock.now();
		await table(ctx.db)
			.deleteFrom('core_changes')
			.where('at', '<', now - CHANGES_KEEP_MS)
			.execute();
		await schedulePruneChanges(ctx, now + DAY_MS);
	},
});

/** One pending job per day, so restarts and the job's own rescheduling never pile up. */
export async function schedulePruneChanges(
	ctx: Pick<ExtensionContext, 'enqueue'>,
	runAt: number,
): Promise<void> {
	await ctx.enqueue(
		PRUNE_CHANGES_JOB,
		{},
		{ runAt, dedupeKey: `${PRUNE_CHANGES_JOB}:${Math.floor(runAt / DAY_MS)}` },
	);
}
