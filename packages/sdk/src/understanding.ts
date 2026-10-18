import { z } from 'zod';
import { type MatchOptions, matchThing, targetOf } from './match-thing.ts';

/**
 * What a model reads from a message, in a small flat shape that is the same whatever extensions
 * are installed: a list of mentions, each a kind and a few shared slots. Names stay names, days
 * stay day references and things to change stay words; code turns them into members, dates and
 * records (`resolvePeople`, `findTarget`, `resolveDay` in `@famos/time`). Nothing here knows a
 * language or an extension.
 */

/** The fixed slots a mention may carry. Kinds choose a subset and describe them. */
export const SLOTS = [
	'title',
	'target',
	'about',
	'people',
	'date',
	'endDate',
	'time',
	'endTime',
	'repeat',
	'place',
	'quantity',
	'amount',
	'notes',
	'lines',
	'tags',
	'variant',
] as const;
export type Slot = (typeof SLOTS)[number];

/** Which day the words name, in language-neutral parts. Code turns it into a date. */
export const DayRefSchema = z.object({
	/** The words of the message that name the day, copied as written ("next Thursday", "15 Ekim"). */
	text: z.string().max(120),
	day: z.number().int().min(1).max(31).optional(),
	month: z.number().int().min(1).max(12).optional(),
	year: z.number().int().min(1900).max(2200).optional(),
	/** 1 = Monday … 7 = Sunday. */
	weekday: z.number().int().min(1).max(7).optional(),
	/** Only when the words say which week. */
	week: z.enum(['this', 'next', 'after_next']).optional(),
	/** Days from today when the words count them ("tomorrow" = 1, "in two weeks" = 14). */
	inDays: z.number().int().min(-366).max(366).optional(),
	/** An all-numeric date exactly as written ("03/04", "3.11.", "2026-10-20"); code reads the order. */
	numeric: z.string().max(20).optional(),
	/** Vague spans ("end of the month", "early November"). */
	approximate: z.boolean().optional(),
});
export type DayRef = z.infer<typeof DayRefSchema>;

export const RepeatSchema = z.object({
	every: z.enum(['day', 'week', 'month', 'year']),
	interval: z.number().int().min(1).max(52).optional(),
	weekdays: z.array(z.number().int().min(1).max(7)).optional(),
	until: DayRefSchema.optional(),
	count: z.number().int().min(1).max(500).optional(),
});
export type Repeat = z.infer<typeof RepeatSchema>;

/** One thing the message states, as the model reads it. Every field but `kind` is optional. */
export const MentionSchema = z.object({
	/** One of the kinds offered for this reading. */
	kind: z.string(),
	/** In the family language. */
	title: z.string().max(200).optional(),
	/** Words naming an existing thing this changes, ticks or cancels. */
	target: z.string().max(200).optional(),
	/** The household record it concerns (a car, a pet, a home). */
	about: z.string().max(120).optional(),
	/** Names as the family list or the message writes them. */
	people: z.array(z.string().max(80)).optional(),
	/** About the person who shared it ("my", "I", "me"). */
	forMe: z.boolean().optional(),
	/** The people were chosen from descriptions, not named. */
	peopleGuessed: z.boolean().optional(),
	date: DayRefSchema.optional(),
	endDate: DayRefSchema.optional(),
	/** HH:MM, 24-hour. */
	time: z.string().max(10).optional(),
	endTime: z.string().max(10).optional(),
	/** The words of the time as written ("4pm", "saat 16.30"). */
	timeText: z.string().max(40).optional(),
	repeat: RepeatSchema.optional(),
	place: z.string().max(200).optional(),
	quantity: z.string().max(40).optional(),
	/** Money or a measure as written. */
	amount: z.string().max(40).optional(),
	notes: z.string().max(300).optional(),
	/** Ingredients, steps, a list's lines. */
	lines: z.array(z.string().max(300)).optional(),
	tags: z.array(z.string().max(40)).optional(),
	/** One of the kind's own choices (a meal slot, a treatment kind). */
	variant: z.string().max(40).optional(),
	/** Slots the model guessed. */
	unsure: z.array(z.string()).optional(),
	/**
	 * The shortest words of the message the mention rests on, copied as written. Code finds them
	 * in the message: they show where a suggestion comes from, and whether it comes from a part
	 * of the message that speaks to the machine reading it (`addressed`).
	 */
	quote: z.string().max(300).optional(),
});
export type Mention = z.infer<typeof MentionSchema>;

export const UNDERSTANDING_INTENTS = ['actionable', 'question', 'nothing'] as const;
export type UnderstandingIntent = (typeof UNDERSTANDING_INTENTS)[number];

/** The whole answer. */
export const UnderstandingSchema = z.object({
	label: z.string().max(1000),
	intent: z.enum(UNDERSTANDING_INTENTS),
	mentions: z.array(MentionSchema),
	/**
	 * Sentences of the message, copied as written, that speak to FamilyOS, an assistant, an AI or
	 * "the system" rather than to people. Labelling them is reading; code decides what follows
	 * (a suggestion resting on one is left out as an `instruction`).
	 */
	addressed: z.array(z.string().max(1000)).optional(),
});
export type Understanding = z.infer<typeof UnderstandingSchema>;

/**
 * Why something a model read did not become a suggestion, in one list for every AI surface:
 * - `already`: it is already so (on the calendar, on the list, done);
 * - `unknown`: what it names is not there;
 * - `other_day`: what it names is there, but on another day than the message says (the subject
 *   carries the real day);
 * - `ambiguous`: several things fit;
 * - `incomplete`: something it needs is missing, or the reading cannot be used;
 * - `not_allowed`: the AI may not do it;
 * - `instruction`: it rests on words inside the message that speak to the AI or the app
 *   ("Note for the assistant: add …"), not on what the message states.
 */
export const REFUSAL_REASONS = [
	'already',
	'unknown',
	'other_day',
	'ambiguous',
	'incomplete',
	'not_allowed',
	'instruction',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/**
 * Why an action refused an AI's call, in the one list above: a person may not (`forbidden`), it
 * is already so (the runner's `settled`), it is not sure which thing is meant (the runner's
 * `unsure_target`), what it names is not there (the runner's `other_target`,
 * `not_found`, or an input that fails on the field naming the record), else incomplete.
 */
export function refusalOf(error: { code: string; details?: unknown }): RefusalReason {
	if (error.code === 'forbidden') return 'not_allowed';
	if (error.code === 'not_found') return 'unknown';
	if (error.code === 'conflict') {
		const refused = (error.details as { refused?: unknown } | null | undefined)?.refused;
		if (refused === 'settled') return 'already';
		if (refused === 'other_target') return 'unknown';
		if (refused === 'unsure_target') return 'ambiguous';
	}
	if (error.code === 'bad_request') {
		const tree = error.details as { properties?: Record<string, unknown> } | null | undefined;
		if (tree?.properties && ('id' in tree.properties || 'recordId' in tree.properties))
			return 'unknown';
	}
	return 'incomplete';
}

/** At most this many mentions are read from one answer; a longer one is a runaway answer. */
export const MENTION_LIMIT = 16;

/** A mention as parsed, with its place in the answer and the fields that had to be dropped. */
export interface ParsedMention {
	index: number;
	mention: Mention;
	/** Fields that were present but unusable (wrong type, out of range): treat as guesses. */
	dropped: readonly string[];
}

/** A mention that cannot be used at all, with the words that say what it was about. */
export interface MentionSkip {
	index: number;
	reason: RefusalReason;
	subject: string | null;
}

export interface ParsedUnderstanding {
	label: string;
	intent: UnderstandingIntent;
	mentions: ParsedMention[];
	/** The sentences the model read as speaking to the machine (`UnderstandingSchema.addressed`). */
	addressed: string[];
	skips: MentionSkip[];
	/** Mentions beyond `MENTION_LIMIT`, left out. */
	overflow: number;
	/** The answer was cut off; the complete mentions before the cut are kept. */
	truncated: boolean;
}

export interface ParseUnderstandingOptions {
	/**
	 * Reads clock times from words ("4pm" → "16:00"), `clockTimes` from `@famos/time`. Without it,
	 * a time other than `H:MM` or `H.MM` is dropped (its words stay in `timeText`).
	 */
	clockTimes?: (text: string) => readonly string[];
}

type Schema = z.ZodType;

const unwrap = (schema: Schema): Schema =>
	schema instanceof z.ZodOptional ? (schema.unwrap() as Schema) : schema;

/** Marks a value that could not be repaired; distinct from "absent". */
const BAD = Symbol('bad');

const looksJson = (text: string, open: string) => text.trimStart().startsWith(open);

function tryJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return BAD;
	}
}

/**
 * A raw value repaired towards a schema: `null` and empty strings are absent, strings trimmed and
 * cut to length, numbers and booleans read from strings, JSON written into a string parsed, a
 * single string where a list belongs made a list, and a list or an object repaired item by item
 * (a bad item is left out and reported). Returns `undefined` for absent, `BAD` for unusable.
 */
function repair(value: unknown, schema: Schema, report: () => void): unknown {
	const base = unwrap(schema);
	if (value === null || value === undefined) return undefined;
	if (base instanceof z.ZodString) {
		if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
		if (typeof value !== 'string') return BAD;
		const text = value.trim();
		if (text === '') return undefined;
		const max = base.maxLength;
		return max !== null && [...text].length > max ? [...text].slice(0, max).join('').trim() : text;
	}
	if (base instanceof z.ZodNumber) {
		if (typeof value === 'string' && /^-?\d+$/u.test(value.trim())) return Number(value.trim());
		return typeof value === 'number' ? value : BAD;
	}
	if (base instanceof z.ZodBoolean) {
		if (value === 'true' || value === 'false') return value === 'true';
		return typeof value === 'boolean' ? value : BAD;
	}
	if (base instanceof z.ZodArray) {
		if (typeof value === 'string' && looksJson(value, '[')) value = tryJson(value);
		if (typeof value === 'string' || typeof value === 'number') value = [value];
		if (!Array.isArray(value)) return BAD;
		const element = base.element as Schema;
		const items = value
			.map((item) => {
				const repaired = repair(item, element, report);
				if (repaired === undefined) return undefined;
				if (repaired === BAD || !element.safeParse(repaired).success) {
					report();
					return undefined;
				}
				return repaired;
			})
			.filter((item) => item !== undefined);
		return items.length > 0 ? items : undefined;
	}
	if (base instanceof z.ZodObject) {
		if (typeof value === 'string' && looksJson(value, '{')) value = tryJson(value);
		if (typeof value !== 'object' || Array.isArray(value) || value === null) return BAD;
		const out: Record<string, unknown> = {};
		for (const [key, field] of Object.entries(base.shape as Record<string, Schema>)) {
			const repaired = repair((value as Record<string, unknown>)[key], field, report);
			const required = !(field instanceof z.ZodOptional);
			if (repaired === undefined) {
				// A required text is the only required part that has an obvious empty value.
				if (required && unwrap(field) instanceof z.ZodString) out[key] = '';
				else if (required) return BAD;
				continue;
			}
			if (repaired === BAD || !field.safeParse(repaired).success) {
				if (required) return BAD;
				report();
				continue;
			}
			out[key] = repaired;
		}
		return out;
	}
	return value;
}

const DAY_PARTS = ['day', 'month', 'year', 'weekday', 'week', 'inDays', 'numeric'] as const;

/** A day reference with nothing in it says nothing; a string is the words of the day. */
function repairDay(value: unknown): unknown {
	if (typeof value === 'string' && !looksJson(value, '{')) {
		const text = value.trim();
		if (text === '') return undefined;
		// An all-numeric string is a date as written; code reads its order.
		return /^[\d\s./-]+$/u.test(text) && /\d/u.test(text) ? { text, numeric: text } : { text };
	}
	return value;
}

const emptyDay = (day: Record<string, unknown>) =>
	day.text === '' && DAY_PARTS.every((part) => day[part] === undefined) && !day.approximate;

/** `H:MM`, `HH.MM` or `HH:MM:SS` as `HH:MM`; anything else through the clock reader, if one is given. */
function repairTime(value: string, options: ParseUnderstandingOptions): string | typeof BAD {
	const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?$/u.exec(value);
	if (m) {
		const [hour, minute] = [Number(m[1]), Number(m[2])];
		if (hour > 23 || minute > 59) return BAD;
		return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
	}
	const read = options.clockTimes?.(value) ?? [];
	return read.length === 1 ? (read[0] as string) : BAD;
}

const MENTION_FIELDS = Object.entries(MentionSchema.shape).filter(([key]) => key !== 'kind') as [
	keyof Mention,
	Schema,
][];

/** One mention, field by field: a bad field is dropped and named, never the whole mention. */
function parseMention(
	raw: Record<string, unknown>,
	kind: string,
	options: ParseUnderstandingOptions,
): { mention: Mention; dropped: string[] } {
	const dropped = new Set<string>();
	const mention: Record<string, unknown> = { kind };
	const source = { ...raw };
	// The day's words written beside the mention instead of in it.
	if (source.date == null && typeof source.dateText === 'string') source.date = source.dateText;
	for (const [key, schema] of MENTION_FIELDS) {
		let value = source[key];
		if (key === 'date' || key === 'endDate') value = repairDay(value);
		let partly = false;
		let repaired = repair(value, schema, () => {
			partly = true;
		});
		if (repaired !== undefined && repaired !== BAD && (key === 'time' || key === 'endTime'))
			repaired = repairTime(repaired as string, options);
		if (
			repaired !== undefined &&
			repaired !== BAD &&
			(key === 'date' || key === 'endDate') &&
			emptyDay(repaired as Record<string, unknown>)
		)
			repaired = undefined;
		if (repaired === undefined) {
			if (partly) dropped.add(key);
			continue;
		}
		if (repaired === BAD || !schema.safeParse(repaired).success) {
			dropped.add(key);
			continue;
		}
		if (partly) dropped.add(key);
		mention[key] = repaired;
	}
	return { mention: mention as Mention, dropped: [...dropped] };
}

/** The first balanced JSON object or array in a text, as written (code fences and prose around it allowed). */
function balancedJson(text: string): string | null {
	const start = text.search(/[{[]/u);
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{' || ch === '[') depth++;
		else if (ch === '}' || ch === ']') {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/**
 * What can be kept of an answer that was cut off: the label and intent when written before the
 * cut, and every mention object that was complete.
 */
function salvage(text: string): Record<string, unknown> | null {
	const list = /"(mentions|proposals|items)"\s*:\s*\[/u.exec(text);
	const quoted = (key: string) => {
		const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`, 'u').exec(text);
		const value = m ? tryJson(m[1] as string) : BAD;
		return typeof value === 'string' ? value : undefined;
	};
	if (!list) return null;
	const mentions: unknown[] = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let begin = -1;
	for (let i = list.index + list[0].length; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{' || ch === '[') {
			if (depth === 0 && ch === '{') begin = i;
			depth++;
		} else if (ch === '}' || ch === ']') {
			if (depth === 0) break;
			depth--;
			if (depth === 0 && begin >= 0) {
				const value = tryJson(text.slice(begin, i + 1));
				if (value !== BAD) mentions.push(value);
				begin = -1;
			}
		}
	}
	return { label: quoted('label'), intent: quoted('intent'), mentions };
}

/** The answer as a value: parsed JSON, the JSON inside a text, or what a cut-off text still holds. */
function answerOf(raw: unknown): { value: unknown; truncated: boolean } {
	if (typeof raw !== 'string') return { value: raw, truncated: false };
	const fenced = /```(?:json)?\s*([\s\S]*?)(?:```|$)/iu.exec(raw);
	const text = (fenced ? fenced[1] : raw) as string;
	const whole = tryJson(text.trim());
	if (whole !== BAD) return { value: whole, truncated: false };
	const inner = balancedJson(text);
	const parsed = inner === null ? BAD : tryJson(inner);
	if (parsed !== BAD) return { value: parsed, truncated: false };
	const kept = salvage(text);
	return kept ? { value: kept, truncated: true } : { value: BAD, truncated: false };
}

const subjectOf = (raw: Record<string, unknown>): string | null => {
	for (const key of ['title', 'target'] as const) {
		const value = raw[key];
		if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 200);
	}
	return null;
};

/**
 * A model's answer read as tolerantly as possible: one bad field never loses its mention, and
 * one bad mention never loses the answer.
 * - The envelope: `label` falls back to `''`, `intent` to `actionable`, `mentions` to none; the
 *   names `proposals` and `items` are read as `mentions`, and a bare list as the mentions.
 * - Each mention is read field by field (see `repair`); dropped fields are named in `dropped`.
 * - A mention whose `kind` is not one of `kinds` is skipped as `incomplete`, with its title or
 *   target as the subject.
 * - Mentions after the `MENTION_LIMIT`th are left out and counted in `overflow`.
 * - A text answer may hold its JSON in code fences or among prose; a cut-off one keeps the
 *   complete mentions before the cut (`truncated`).
 * Null when the answer holds no JSON at all.
 */
export function parseUnderstanding(
	raw: unknown,
	kinds: readonly string[],
	options: ParseUnderstandingOptions = {},
): ParsedUnderstanding | null {
	const { value: answer, truncated } = answerOf(raw);
	if (answer === BAD || answer === null || typeof answer !== 'object') return null;
	const envelope: Record<string, unknown> = Array.isArray(answer)
		? { mentions: answer }
		: (answer as Record<string, unknown>);
	const labelValue = repair(envelope.label, UnderstandingSchema.shape.label, () => {});
	const intent = UNDERSTANDING_INTENTS.find((i) => i === envelope.intent) ?? 'actionable';
	let list = envelope.mentions ?? envelope.proposals ?? envelope.items;
	if (typeof list === 'string' && looksJson(list, '[')) list = tryJson(list);
	const entries = Array.isArray(list) ? list : [];
	const addressedValue = repair(envelope.addressed, UnderstandingSchema.shape.addressed, () => {});
	const addressed = Array.isArray(addressedValue)
		? addressedValue.filter((line): line is string => typeof line === 'string')
		: [];
	const offered = new Set(kinds);
	const mentions: ParsedMention[] = [];
	const skips: MentionSkip[] = [];
	entries.slice(0, MENTION_LIMIT).forEach((entry, index) => {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
			skips.push({ index, reason: 'incomplete', subject: null });
			return;
		}
		const fields = entry as Record<string, unknown>;
		const kind = typeof fields.kind === 'string' ? fields.kind.trim() : '';
		if (!offered.has(kind)) {
			skips.push({ index, reason: 'incomplete', subject: subjectOf(fields) });
			return;
		}
		const { mention, dropped } = parseMention(fields, kind, options);
		mentions.push({ index, mention, dropped });
	});
	return {
		label: typeof labelValue === 'string' ? labelValue : '',
		intent,
		mentions,
		addressed,
		skips,
		overflow: Math.max(0, entries.length - MENTION_LIMIT),
		truncated,
	};
}

/** Who a mention is about, as members. */
export interface PeopleResult {
	/** The members, without repeats, in the order named (the sharer last when `forMe`). */
	ids: string[];
	/**
	 * False when the people were guessed, a member was matched whose name the shared text does
	 * not write, or "for me" was read with no known sharer.
	 */
	certain: boolean;
	/** Names that are no member (or could be several): keep them in the title, not as people. */
	unmatched: string[];
}

export interface ResolvePeopleOptions {
	members: readonly { id: string; displayName: string }[];
	/** The member who shared the message, when known. */
	sharer: string | null;
	/** The shared text, or null when files were read (then names cannot be checked against it). */
	text: string | null;
	/** The family language, for lower-casing. */
	locale: string;
}

/**
 * The members a mention names. A name matches a member when it shares a whole word with the
 * display name; words are split at anything that is not a letter or digit, so a possessive after
 * an apostrophe ("Deniz’in") still names Deniz. When several members share a word, the one whose
 * name the words spell completely, or else shares the most words, is taken; a tie is unmatched.
 * Matching needs only the family's own list, never the model's, so it works when names were not
 * sent to the model: the names the message writes are matched here, at home. Names are the
 * family's data, so this works in any language.
 */
export function resolvePeople(
	mention: Pick<Mention, 'people' | 'forMe' | 'peopleGuessed'>,
	options: ResolvePeopleOptions,
): PeopleResult {
	const wordsOf = (value: string) =>
		value
			.toLocaleLowerCase(options.locale)
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => [...word].length > 1);
	const members = options.members.map((m) => ({ id: m.id, words: wordsOf(m.displayName) }));
	const said = options.text === null ? null : new Set(wordsOf(options.text));
	const ids: string[] = [];
	const unmatched: string[] = [];
	let certain = mention.peopleGuessed !== true;
	for (const name of mention.people ?? []) {
		const words = wordsOf(name);
		const scored = members
			.map((m) => ({
				id: m.id,
				exact: m.words.length > 0 && m.words.every((w) => words.includes(w)),
				shared: m.words.filter((w) => words.includes(w)).length,
				words: m.words,
			}))
			.filter((m) => m.shared > 0);
		const exact = scored.filter((m) => m.exact);
		const pool = exact.length > 0 ? exact : scored;
		const best = Math.max(0, ...pool.map((m) => m.shared));
		const top = pool.filter((m) => m.shared === best);
		const [only] = top;
		if (top.length !== 1 || !only) {
			if (name.trim() !== '') unmatched.push(name.trim());
			continue;
		}
		if (said !== null && !only.words.some((w) => said.has(w))) certain = false;
		if (!ids.includes(only.id)) ids.push(only.id);
	}
	if (mention.forMe) {
		if (options.sharer === null) certain = false;
		else if (!ids.includes(options.sharer)) ids.push(options.sharer);
	}
	return { ids, certain, unmatched };
}

/**
 * Which of some candidates the words name: the one surely named, nothing, or things it may be
 * that a person must choose between (`ambiguous`). `unsure` marks those that are only partly
 * named (most of the words, or the words in other forms), rather than several that fit as well:
 * nothing may pick one of them for the person, not even the day.
 */
export type TargetResult<T> =
	| { found: T; unsure?: true }
	| { none: true }
	| { ambiguous: readonly T[]; unsure?: true };

/**
 * Which existing thing a mention's `target` words name, among the candidates an extension reads
 * from its own tables, by `matchThing`: an `exact` or `strong` match is `found`; the one thing
 * named by other forms of the same words is `found` with `unsure` (the proposal marks its target
 * for a person to check: `UNSURE_TARGET`); any other `weak` match is `ambiguous` (several equally
 * good, or a partial match only the person can confirm); nothing is `none`. With `text` (the
 * shared message), the choice must also be the thing the message names most.
 */
export function findTarget<T extends { label: string }>(
	words: string | undefined,
	candidates: readonly T[],
	options: MatchOptions = {},
): TargetResult<T> {
	const match = matchThing(words, candidates, options);
	if (match.band === 'none' || !match.candidate) return { none: true };
	const acted = targetOf(match);
	if (acted === 'sure') return { found: match.candidate };
	if (acted === 'marked') return { found: match.candidate, unsure: true };
	// Several equally good names may still be told apart (by the day); guesses never are.
	return match.reason === 'several' && match.each !== 'weak'
		? { ambiguous: match.candidates }
		: { ambiguous: match.candidates, unsure: true };
}

/**
 * The input field a proposal lists as uncertain when the thing it changes is a guess: the `id`
 * of what it changes, ticks or cancels. A card shows it as "check this" on what it names.
 */
export const UNSURE_TARGET = 'id';

/** At most this many things are named in a "which one?" line. */
const WHICH_MAX = 3;

/**
 * The subject of a refusal that asks which one is meant: the person's words, then the things they
 * may mean, by their own names ("football (Football training, Football match)"). Names that only
 * say the words again are left out: two things called "Fish" are told as "Fish".
 */
export function whichOne(words: string, candidates: readonly { label: string }[]): string {
	const said = words.trim().toLocaleLowerCase();
	const names = [...new Set(candidates.map((c) => c.label.trim()).filter(Boolean))].filter(
		(name) => name.toLocaleLowerCase() !== said,
	);
	if (names.length === 0) return words;
	const shown = names.slice(0, WHICH_MAX).join(', ');
	return `${words} (${names.length > WHICH_MAX ? `${shown}, …` : shown})`;
}

/*
 * Kinds: what an extension lets the model read for it. Each kind says in English what it is,
 * which slots it uses and how a careful reader fills them (examples), and brings a resolver that
 * turns the mentions read into suggestions of actions, or into refusals with a reason.
 */

/** A household record the reading listed (read as the AI actor), for `MentionContext.record`. */
export interface MentionRecord {
	/** What it is, as its AI context names it (`vehicle`, `pet`). */
	kind: string;
	id: string;
	label: string;
	/** A path inside the app that opens it. */
	url?: string;
}

/** What the caller knows about one reading, besides the mentions. */
export interface MentionEnv {
	/** The shared text, or null when files were read (then targets are checked against `target` only). */
	text: string | null;
	/** The member who shared it, when known. */
	sharer: string | null;
	/** The household records listed for this reading, already read as the AI actor. */
	records: readonly MentionRecord[];
}

/** A day a resolver read, and whether it is certain (`resolveDay` of `@famos/time`). */
export interface ResolvedDay {
	/** `YYYY-MM-DD`; the first day of a span. */
	date: string;
	/**
	 * The last day, `YYYY-MM-DD`, when the words name a span rather than a day ("this week",
	 * "in November"): then `date` is only where it starts, and something on any day of it fits.
	 */
	to?: string;
	certain: boolean;
	why?: 'mismatch' | 'approximate' | 'guessed_year' | 'weekday_only' | 'relative';
}

/** A clock time a resolver read. */
export interface ResolvedTime {
	/** `HH:MM`, 24-hour. */
	time: string;
	/** False when the words do not settle it (a bare hour on a 12-hour clock). */
	certain: boolean;
}

/** A mention handed to a resolver, with its place in the answer. */
export interface IndexedMention {
	index: number;
	mention: Mention;
}

/**
 * How a proposal's input field was decided:
 * - `written`: copied from the message;
 * - `matched`: found by the matcher, surely (a doubtful match is marked uncertain on its own);
 * - `defaulted`: a default took its place (the whole family, a default list or section, today);
 * - `inferred`: worked out (an occurrence of a series, a date from a weekday, a time from a period).
 * The host marks every `defaulted` and `inferred` field as uncertain, so no guess is silent.
 */
export const FIELD_DECISIONS = ['written', 'matched', 'defaulted', 'inferred'] as const;
export type FieldDecision = (typeof FIELD_DECISIONS)[number];

/** A suggestion a resolver makes of one or more mentions. */
export interface MentionProposal {
	/** One of the kind's `actions`. */
	actionId: string;
	/** The action's input; the action runner validates it. */
	input: unknown;
	/**
	 * The words of the message it rests on (a new thing's title, the target words as written),
	 * for the suggestion's lines and to check that the message says it; null when none.
	 */
	subject: string | null;
	/**
	 * The real title of the existing thing it changes, ticks or cancels, as the extension's own
	 * tables hold it; absent when it makes something new.
	 */
	targetTitle?: string;
	/** Input fields (dot paths) that rest on a guess, shown as "check this". */
	uncertain?: readonly string[];
	/**
	 * How the input fields this proposal decided other than by copying were decided. Each field
	 * named here must be one its kind declares in `decides`; `defaulted` and `inferred` ones are
	 * added to `uncertain` by the host.
	 */
	decided?: Readonly<Record<string, FieldDecision>>;
	/** The mentions it comes from. */
	from: readonly number[];
}

/** Mentions that did not become a suggestion, and why. */
export interface MentionRefusal {
	reason: RefusalReason;
	/** The words naming what it was about, for the line that says it was left out. */
	subject: string | null;
	from: readonly number[];
}

/**
 * A mention a resolver hands to another extension's kind, because what it states is that kind's
 * thing: a vaccination still to come is an appointment (`calendar.event`), not a treatment given.
 * The host resolves `mention` with that kind's resolver when the kind is offered for the reading,
 * and refuses it as `incomplete` when not. It is handed on once: a hand-off of a handed-off
 * mention is refused.
 */
export interface MentionHandOff {
	/** One of the kind's `handsOff`. */
	kind: string;
	/** The mention as that kind reads it (its `kind` is set by the host). */
	mention: Mention;
	from: readonly number[];
}

/**
 * What a resolver made of mentions. Each mention backs exactly one resolution, and one
 * resolution may merge several (shopping items into one list change), so a reading never yields
 * more suggestions than mentions: text that tries to multiply suggestions cannot.
 */
export type Resolution =
	| { propose: MentionProposal }
	| { refuse: MentionRefusal }
	| { handOff: MentionHandOff };

/** A resolution as the host hands it back: hand-offs are resolved by then. */
export type SettledResolution = Exclude<Resolution, { handOff: MentionHandOff }>;

/** An example of a kind: a message and what a careful reader extracts from it. */
export interface MentionExample {
	/** A short message in English, with neutral names and places and days in words. */
	text: string;
	/** The mentions to read, of this extension's kinds; none when there is nothing to read. */
	mentions: readonly Mention[];
	/** One line on why, shown to the model ("news that it is cancelled changes it"). */
	why?: string;
}

/** A kind as the AI pipeline sees it: everything but its resolver and actions. */
export interface AiKindInfo {
	id: string;
	/** The extension that owns it. */
	extension: string;
	describe: string;
	slots: Partial<Record<Slot, string>>;
	variants?: readonly string[];
	knownFrom?: readonly string[];
	drawsOn?: readonly string[];
	examples: readonly MentionExample[];
	/** At most this many of its mentions are resolved from one reading. */
	limit: number;
}
