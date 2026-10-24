import { z } from 'zod';
import { type ActionDefinition, defineAction } from './actions.ts';
import type { UnitOfWork } from './context.ts';
import { idSchema } from './ids.ts';
import { sameStem } from './label-words.ts';
import type { QuestionTopic } from './question.ts';
import { DAY_MS } from './time-units.ts';

/*
 * A digest answers one question per topic: "what is there for these people in these days".
 * Code asks it, as the AI actor, for each topic a question is about, and renders the facts from
 * what comes back; the model never chooses what to read. One read-only action per topic declares
 * it (`defineDigest`), and every digest has the same input and the same output.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const IsoDate = z.string().regex(ISO_DATE, 'Expected YYYY-MM-DD');
const ClockTime = z.string().regex(/^\d{2}:\d{2}$/, 'Expected HH:MM');

/** The longest span a digest reads, in days from the first to the last. */
export const DIGEST_MAX_DAYS = 62;

/** How many items a digest returns at most, unless it says another limit. */
export const DIGEST_LIMIT = 60;

/** How long an item's notes may be; longer notes are cut and end with "…". */
export const DIGEST_NOTES_MAX = 300;

/**
 * A path inside the app that opens a digest item (`/calendar?event=…&on=2026-10-22`): it starts
 * with one slash, so it can never leave the app.
 */
export const DigestHrefSchema = z
	.string()
	.max(300)
	.regex(/^\/(?!\/)[^\s\\]*$/, 'Expected a path inside the app');

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

export const DigestInputSchema = z
	.object({
		/** The first day, included (YYYY-MM-DD, family time). */
		from: IsoDate,
		/** The last day, included. */
		to: IsoDate,
		/**
		 * Only what is for these members, and what is for the whole family or anyone (an event for
		 * everyone, a task anyone may do). Left out: everyone's.
		 */
		memberIds: z.array(idSchema('member')).max(20).optional(),
		/**
		 * Words of the thing asked about ("pick up", "dentist"). Items whose words meet them come
		 * first; no item is ever left out for them, because the person's words need not be the
		 * title's (a pick-up may be a Swimming lesson).
		 */
		about: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
	})
	.refine((v) => v.to >= v.from, { message: 'The span ends before it starts', path: ['to'] })
	.refine((v) => dayNumber(v.to) - dayNumber(v.from) <= DIGEST_MAX_DAYS, {
		message: `The span may cover at most ${DIGEST_MAX_DAYS} days`,
		path: ['to'],
	});
export type DigestInput = z.infer<typeof DigestInputSchema>;

/**
 * What a digest item is:
 * - `event`: on the calendar;
 * - `task`: a task due;
 * - `shopping_list`: a shopping list with things still to buy (one item per list);
 * - `chore`: a turn of a chore;
 * - `meal`: a meal planned;
 * - `duty`: something a record needs (an inspection, a vaccination, a warranty that ends);
 * - `note`: a note on the family board;
 * - `suggestion`: a suggestion waiting for a decision.
 */
export const DIGEST_KINDS = [
	'event',
	'task',
	'shopping_list',
	'chore',
	'meal',
	'duty',
	'note',
	'suggestion',
] as const;
export type DigestKind = (typeof DIGEST_KINDS)[number];

/**
 * - `past`, `now`, `upcoming`: an event of today, over, on now or still ahead;
 * - `overdue`: due before today and not done (its `date` is the day it was due);
 * - `pinned`: a note pinned to the board;
 * - `waiting`: a suggestion nobody has decided yet;
 * - `failed`: a suggestion that was approved but could not be applied, so it waits again.
 */
export const DIGEST_STATUSES = [
	'past',
	'now',
	'upcoming',
	'overdue',
	'pinned',
	'waiting',
	'failed',
] as const;
export type DigestStatus = (typeof DIGEST_STATUSES)[number];

export const DigestItemSchema = z.object({
	/**
	 * The thing's typed id, which the host turns into a handle before a model reads it (as for
	 * every AI read); null for what has none of its own (an event of a subscribed calendar).
	 */
	handle: z.string().nullable(),
	kind: z.enum(DIGEST_KINDS),
	title: z.string().min(1).max(300),
	/**
	 * The item's day (YYYY-MM-DD, family time): when it happens or is due. Something overdue keeps
	 * the day it was due, before the span. What stands over days instead of happening on one (a
	 * note on the board, a waiting suggestion, a shopping list) has the first day of the span it
	 * stands on.
	 */
	date: IsoDate,
	/** HH:MM, family time, when it has a time of day. */
	time: ClockTime.optional(),
	/** When it ends, when it ends on another day or at a time. */
	end: z.object({ date: IsoDate.optional(), time: ClockTime.optional() }).optional(),
	/** True for something that lasts the whole day (an all-day event). */
	allDay: z.boolean().optional(),
	/** The members it is for (or whose turn it is); empty: the whole family, or anyone. */
	people: z.array(z.string()),
	/** Its notes as people wrote them, cut at `DIGEST_NOTES_MAX` characters. */
	notes: z
		.string()
		.max(DIGEST_NOTES_MAX + 1)
		.optional(),
	status: z.enum(DIGEST_STATUSES).optional(),
	/**
	 * A few more facts of its kind, as text: the place of an event, the meal slot, the record a
	 * duty is for, how many things a list still has. A typed id here becomes a handle as well.
	 */
	extra: z.record(z.string(), z.string().max(300)).optional(),
	/**
	 * Where the app opens this item, from the page routes of the extension that keeps it. Only
	 * for the app's own screens: it holds typed ids, so no model ever reads it (a digest is not
	 * a tool, and `readableOutput` drops every `href`).
	 */
	href: DigestHrefSchema.optional(),
});
export type DigestItem = z.infer<typeof DigestItemSchema>;

export const DigestOutputSchema = z.object({
	/** In the span, for the people asked about; those that meet `about` first, then by day. */
	items: z.array(DigestItemSchema),
	/** True when there were more items than the digest returns. */
	truncated: z.boolean(),
	/**
	 * Only when nothing is in the span: the first item after it (of the same people), so an
	 * answer says "nothing this weekend; next: …" instead of "there is none".
	 */
	nextAfter: DigestItemSchema.optional(),
	/**
	 * How many items were left out because the AI may not read them (their area is closed to it),
	 * so an answer can say that there is more it cannot see.
	 */
	hidden: z.number().int().min(1).optional(),
});
export type DigestOutput = z.infer<typeof DigestOutputSchema>;

/** Notes as a digest carries them: trimmed, cut with "…", and left out when empty. */
export function digestNotes(text: string | null | undefined): string | undefined {
	const trimmed = text?.trim();
	if (!trimmed) return undefined;
	return trimmed.length > DIGEST_NOTES_MAX
		? `${trimmed.slice(0, DIGEST_NOTES_MAX).trimEnd()}…`
		: trimmed;
}

/**
 * Whether something for `people` belongs in a digest for `memberIds`: everything when nobody was
 * asked about, and otherwise what is for one of them or for everyone (no people).
 */
export function digestForPeople(
	people: readonly string[],
	memberIds: readonly string[] | undefined,
): boolean {
	if (!memberIds || memberIds.length === 0 || people.length === 0) return true;
	return people.some((id) => memberIds.includes(id));
}

const wordsOf = (text: string) => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * How many of the `about` words an item's title, notes and extra facts meet, as words or forms of
 * them ("swim" and "swimming", the rule of read tools' text filters).
 */
export function digestAboutScore(item: DigestItem, about: readonly string[]): number {
	const wanted = [...new Set(about.flatMap(wordsOf))];
	if (wanted.length === 0) return 0;
	const own = wordsOf([item.title, item.notes ?? '', ...Object.values(item.extra ?? {})].join(' '));
	return wanted.filter((w) => own.some((o) => sameStem(w, o))).length;
}

/**
 * Items in the order a digest gives them: those that meet more of the `about` words first, the
 * others after them in the order they came. Nothing is left out.
 */
export function rankDigest(items: readonly DigestItem[], about: readonly string[] = []) {
	if (about.length === 0) return [...items];
	return items
		.map((item, index) => ({ item, index, score: digestAboutScore(item, about) }))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.item);
}

/**
 * The digest's answer from its items in day order: ranked by `about`, cut at `limit`, and, when
 * the span holds nothing, with the first item after it (`next` is only asked then).
 */
export async function digestOf(
	items: readonly DigestItem[],
	input: Pick<DigestInput, 'about'>,
	options: {
		limit?: number;
		next?: () => Promise<DigestItem | null | undefined>;
		hidden?: number;
	} = {},
): Promise<DigestOutput> {
	const limit = options.limit ?? DIGEST_LIMIT;
	const ranked = rankDigest(items, input.about);
	const nextAfter = ranked.length === 0 && options.next ? await options.next() : undefined;
	return {
		items: ranked.slice(0, limit),
		truncated: ranked.length > limit,
		...(nextAfter && { nextAfter }),
		...(options.hidden !== undefined && options.hidden > 0 && { hidden: options.hidden }),
	};
}

/**
 * The digest of a topic: a read-only action with the digest's input and output, offered to the
 * AI as the topic's digest (`ai.digest`) and never as a tool of its own. An extension declares at
 * most one per topic, and only for a topic its area keeps (`QUESTION_TOPICS`); `requires` is its
 * view capability. The `description` says, for a model or a developer, what its items are.
 */
export function defineDigest<const Id extends string>(definition: {
	id: Id;
	topic: QuestionTopic;
	title: string;
	description: string;
	requires?: string;
	run(uow: UnitOfWork, input: DigestInput): Promise<DigestOutput>;
}): ActionDefinition<Id, typeof DigestInputSchema, typeof DigestOutputSchema> {
	return defineAction({
		id: definition.id,
		title: definition.title,
		input: DigestInputSchema,
		output: DigestOutputSchema,
		readOnly: true,
		...(definition.requires !== undefined && { requires: definition.requires }),
		ai: { description: definition.description, digest: definition.topic },
		run: (uow, input) => definition.run(uow, input),
	});
}
