import type { DuplicateContext } from './actions.ts';
import {
	type DayRef,
	type FieldDecision,
	type IndexedMention,
	MENTION_LIMIT,
	type Mention,
	type MentionExample,
	type MentionRecord,
	MentionSchema,
	type PeopleResult,
	type RefusalReason,
	type Resolution,
	type ResolvedDay,
	type ResolvedTime,
	SLOTS,
	type Slot,
	type TargetResult,
} from './understanding.ts';

/*
 * The definition side of mention kinds: what an extension declares and what its resolver may
 * read. The shapes the AI pipeline passes around live in `understanding.ts`.
 */

/**
 * What a resolver may read, besides its own tables: the family's region formats, this reading,
 * and helpers bound to both. `db` reaches the extension's own tables and only reads: a resolver
 * writes nothing, and what it proposes is still validated and authorized by the action runner.
 */
export interface MentionContext extends DuplicateContext {
	/** Today in the family time zone, `YYYY-MM-DD`. */
	readonly today: string;
	/** Epoch milliseconds. */
	readonly now: number;
	/** The time now in the family time zone, `HH:MM`. */
	readonly clock: string;
	readonly timeZone: string;
	/** 1 = Monday … 7 = Sunday. */
	readonly weekStart: number;
	/** Order of the family's all-numeric dates. */
	readonly dateOrder: 'DMY' | 'MDY' | 'YMD';
	readonly hourCycle: 'h12' | 'h23';
	/** The family language, for titles and lower-casing. */
	readonly locale: string;
	/** The region format (`en-GB`). */
	readonly formatLocale: string;
	/** The shared text, or null when files were read. */
	readonly text: string | null;
	/** The member who shared it, when known. */
	readonly sharer: string | null;
	/** The active members. */
	readonly members: readonly { id: string; displayName: string }[];
	/** The household records listed for this reading. */
	readonly records: readonly MentionRecord[];
	/** The words a key lists in every installed language (see `ExtensionContext.vocabulary`). */
	vocabulary(key: string): readonly string[];
	/**
	 * The date a day reference names: in `direction` when no year or month says (`future` for
	 * plans, `past` for things done; default `future`); with `time`, today's own weekday is today
	 * only while that time is still ahead. The quoted words are checked against the parts with
	 * the date words of every installed language. Null when nothing names a day.
	 */
	day(
		ref: DayRef | undefined,
		direction?: 'future' | 'past' | 'nearest',
		time?: string,
	): ResolvedDay | null;
	/** The time a mention names: a clock time its words (`timeText`) write wins over `time`. */
	time(mention: Pick<Mention, 'time' | 'timeText'>): ResolvedTime | null;
	/** The members a mention names (`resolvePeople`, with this reading's text and sharer). */
	people(mention: Pick<Mention, 'people' | 'forMe' | 'peopleGuessed'>): PeopleResult;
	/**
	 * Which candidate `target` words name (`findTarget` on `matchThing`, in the family language,
	 * checked against this reading's text). Only a sure match is `found`; a partial one or a tie is
	 * `ambiguous`, to be refused with `whichOne` so the person is asked.
	 */
	target<T extends { label: string }>(
		words: string | undefined,
		candidates: readonly T[],
	): TargetResult<T>;
	/** Which listed household record `about` words name, among `kinds` when given. */
	record(words: string | undefined, kinds?: readonly string[]): TargetResult<MentionRecord>;
}

export interface MentionKindDefinition {
	/** `<extension>.<kind>`, e.g. `calendar.eventCancel`. */
	id: string;
	/** For the model, in English: what it is and when to choose it (and when not). */
	describe: string;
	/** The slots this kind uses, each with a short English description for the model. */
	slots: Partial<Record<Slot, string>>;
	/** The allowed `variant` values, exactly when the kind uses `variant`. */
	variants?: readonly string[];
	/**
	 * The AI-proposable actions the resolver may suggest: this extension's own, or ones its
	 * manifest `calls`. The kind is offered only while all of them are offered to the AI for the
	 * reading (areas, local-only, features, and the person the AI works for).
	 */
	actions: readonly string[];
	/** This extension's `ai.context` actions whose item labels are shown as known names. */
	knownFrom?: readonly string[];
	/**
	 * Extensions whose records the resolver looks among (the home, pets and vehicles a duty
	 * belongs to). When it finds none of what a mention names while one of them is not installed,
	 * turned off or closed to the AI, the person is told which, not only that nothing was found.
	 */
	drawsOn?: readonly string[];
	/** Examples, edge cases included; the first few are shown to the model. */
	examples: readonly MentionExample[];
	/**
	 * At most this many mentions of the kind are resolved from one reading (default and at most
	 * `MENTION_LIMIT`); later ones are refused as `incomplete`. For things a message holds one or
	 * two of (a cancellation), so a runaway answer cannot become a pile of suggestions.
	 */
	limit?: number;
	/**
	 * Kinds of other extensions (named in the manifest's `dependsOn` or `optional`) the resolver
	 * may hand a mention to, when what the mention states is that kind's thing (`handOff`).
	 */
	handsOff?: readonly string[];
	/**
	 * The input fields (dot paths; `*` stands for an index) whose value this kind's resolver may
	 * settle without the message writing it, and how: `defaulted` (the whole family, a default
	 * list, today) or `inferred` (an occurrence, a date from a weekday). A kind that never does
	 * declares `{}`. A proposal reports which of them it used in `decided`, and the host marks
	 * those fields "check this". Optional so that existing packages stay valid; every bundled
	 * kind declares it.
	 */
	decides?: Readonly<Record<string, Exclude<FieldDecision, 'written' | 'matched'>>>;
	/**
	 * Turns mentions of this kind, in answer order, into suggestions and refusals. Each mention
	 * goes into exactly one resolution's `from`; one left out is refused as `incomplete`. A mention
	 * that is another kind's thing is handed to it (`handOff`, to one of `handsOff`). It only
	 * reads, and may be called again with the same mentions.
	 */
	resolve(ctx: MentionContext, mentions: readonly IndexedMention[]): Promise<readonly Resolution[]>;
}

export function defineMentionKind(definition: MentionKindDefinition): MentionKindDefinition {
	return definition;
}

/**
 * The slot of a mention field; the bookkeeping fields (`kind`, `unsure`, `quote`) and the link to
 * another mention (`detailOf`) have none.
 */
function slotOfField(field: string): Slot | null {
	if (['kind', 'unsure', 'quote', 'detailOf'].includes(field)) return null;
	if (field === 'forMe' || field === 'peopleGuessed') return 'people';
	if (field === 'timeText') return 'time';
	return field as Slot;
}

const StrictMentionSchema = MentionSchema.strict();

/**
 * What is wrong with a kind, on its own and against its extension's other kinds: its id, slots,
 * variants, limit and examples (each must read as a mention of one of the extension's kinds and
 * fill only slots that kind uses). Empty when nothing is. Its actions and `knownFrom` need the
 * other extensions, so the registry checks them.
 */
export function mentionKindProblems(
	extensionId: string,
	kind: MentionKindDefinition,
	kinds: readonly MentionKindDefinition[],
): string[] {
	const problems: string[] = [];
	const where = `Mention kind "${kind.id}"`;
	const name = kind.id.startsWith(`${extensionId}.`) ? kind.id.slice(extensionId.length + 1) : '';
	if (!/^[a-z][A-Za-z0-9]*$/u.test(name))
		problems.push(`${where} must be namespaced as "${extensionId}.<name>"`);
	if (kind.describe.trim() === '') problems.push(`${where} has no description`);
	const slots = Object.entries(kind.slots) as [string, string | undefined][];
	if (slots.length === 0) problems.push(`${where} uses no slot`);
	for (const [slot, text] of slots) {
		if (!(SLOTS as readonly string[]).includes(slot))
			problems.push(`${where} names unknown slot "${slot}"`);
		else if (!text?.trim()) problems.push(`${where} does not describe slot "${slot}"`);
	}
	if ((kind.slots.variant !== undefined) !== (kind.variants !== undefined))
		problems.push(`${where} must list variants exactly when it uses the variant slot`);
	if (kind.variants) {
		const empty = kind.variants.length === 0 || kind.variants.some((v) => v.trim() === '');
		if (empty || new Set(kind.variants).size !== kind.variants.length)
			problems.push(`${where} lists no, empty or repeated variants`);
	}
	if (kind.actions.length === 0) problems.push(`${where} names no action`);
	if (new Set(kind.actions).size !== kind.actions.length)
		problems.push(`${where} names an action twice`);
	if (
		kind.limit !== undefined &&
		(!Number.isInteger(kind.limit) || kind.limit < 1 || kind.limit > MENTION_LIMIT)
	)
		problems.push(`${where} has a limit outside 1 to ${MENTION_LIMIT}`);
	if (kind.examples.length === 0) problems.push(`${where} has no example`);
	for (const other of kind.handsOff ?? [])
		if (!/^[a-z][a-z0-9-]*\.[a-z][A-Za-z0-9]*$/u.test(other) || other.startsWith(`${extensionId}.`))
			problems.push(`${where} hands mentions to "${other}", which is no kind of another extension`);
	const byId = new Map(kinds.map((k) => [k.id, k]));
	kind.examples.forEach((example, i) => {
		const at = `${where}, example ${i + 1},`;
		if (example.text.trim() === '') problems.push(`${at} has no text`);
		example.mentions.forEach((raw, place) => {
			const parsed = StrictMentionSchema.safeParse(raw);
			if (!parsed.success) {
				const issue = parsed.error.issues[0];
				problems.push(
					`${at} does not read as a mention: ${issue?.path.join('.') || '(mention)'}: ${issue?.message}`,
				);
				return;
			}
			const mention = parsed.data;
			if (
				mention.detailOf !== undefined &&
				(mention.detailOf === place || mention.detailOf >= example.mentions.length)
			)
				problems.push(`${at} points with "detailOf" at no other mention of the example`);
			// The model copies what the examples do: each shows the words it rests on, as written.
			if (!mention.quote?.trim()) problems.push(`${at} has a mention without its quote`);
			else if (!example.text.includes(mention.quote))
				problems.push(`${at} quotes "${mention.quote}", which its text does not write`);
			const owner = byId.get(mention.kind);
			if (!owner) {
				problems.push(`${at} names kind "${mention.kind}", which "${extensionId}" lacks`);
				return;
			}
			for (const field of Object.keys(mention)) {
				const slot = slotOfField(field);
				if (slot !== null && owner.slots[slot] === undefined)
					problems.push(`${at} fills "${field}", which kind "${owner.id}" does not use`);
			}
			for (const slot of mention.unsure ?? []) {
				const of = slotOfField(slot);
				if (of === null || owner.slots[of] === undefined)
					problems.push(`${at} is unsure of "${slot}", which kind "${owner.id}" does not use`);
			}
			if (mention.variant !== undefined && !owner.variants?.includes(mention.variant))
				problems.push(`${at} has variant "${mention.variant}", which kind "${owner.id}" lacks`);
		});
	});
	return problems;
}

/** `YYYY-MM-DD` of the last day of the month a date is in. */
function monthEnd(date: string): string {
	const [year, month] = date.split('-').map(Number) as [number, number];
	const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return `${date.slice(0, 8)}${String(last).padStart(2, '0')}`;
}

/**
 * The day an end or a deadline names ("until 28 October", "by Friday"). When it names a month or
 * a span but no day ("until the end of October", "by the end of the month": no day number, no
 * counted days, no weekday, and no digits in its words), it is the last day of that month: read
 * as a day, a month alone is its first day, which would end a series or a deadline a month
 * early. A week named ends on its last day. A day the model gives is kept, also one written in words ("the twentieth"). A month
 * named is certain; a span without one is this month (or the month of the date read), as a guess.
 */
export function endNamed(
	ctx: Pick<MentionContext, 'day' | 'today'>,
	ref: DayRef | undefined,
): ResolvedDay | null {
	const found = ctx.day(ref, 'future');
	if (!ref) return found;
	const noDay =
		ref.day === undefined &&
		ref.inDays === undefined &&
		ref.weekday === undefined &&
		!ref.numeric?.trim() &&
		!/\p{N}/u.test(ref.text);
	// A month read from the words alone ("Ekim sonuna kadar" with no parts) is approximate too.
	const monthInWords =
		ref.month === undefined && found?.certain === false && found.why === 'approximate';
	const spanOnly = noDay && (ref.month !== undefined || ref.approximate === true || monthInWords);
	// A week or a month the words name ends where that span ends, in the family's week start:
	// "by the end of this week" is its last day, never the end of the month.
	if (noDay && found?.to !== undefined && ref.month === undefined)
		return { date: found.to, certain: false, why: 'approximate' };
	if (!spanOnly) return found;
	const date = monthEnd(found?.date ?? ctx.today);
	return ref.month !== undefined && ref.approximate !== true
		? { date, certain: true }
		: { date, certain: false, why: 'approximate' };
}

/**
 * Whether what a mention states is still to come: its day is after today, or it is today (or it
 * names no day) at a time still ahead. A kind for things done (a treatment given, work done on a
 * car) reads such a mention as an appointment and hands it to the calendar's kind. The day is
 * read as the nearest one, so a date written without a year is not pushed into last year, and a
 * weekday alone is not enough.
 */
export function stillToCome(
	ctx: Pick<MentionContext, 'day' | 'time' | 'today' | 'clock'>,
	mention: Pick<Mention, 'date' | 'time' | 'timeText'>,
): boolean {
	const time = ctx.time(mention);
	const day = ctx.day(mention.date, 'nearest', time?.time);
	if (day && day.date < ctx.today) return false;
	// A weekday alone fits a coming day and a past one alike; the kind chosen says done.
	if (day && day.date > ctx.today) return day.why !== 'weekday_only';
	return time !== null && time.time > ctx.clock;
}

/**
 * A mention of something done (a treatment, work on a car) that is still to come, as the
 * appointment it is, for a hand-off to the calendar's kind: its title with the name of what it is
 * for in front (unless the title holds it), and its day, time, place, notes and quote. The host
 * sets the kind.
 */
export function asAppointment(mention: Mention, about: string | null, locale: string): Mention {
	const what = mention.title?.trim() ?? '';
	const named =
		about !== null && what.toLocaleLowerCase(locale).includes(about.toLocaleLowerCase(locale));
	const title =
		about === null || named ? what || (about ?? '') : what ? `${about} · ${what}` : about;
	return {
		kind: mention.kind,
		...(title && { title }),
		...(mention.quote && { quote: mention.quote }),
		...(mention.date && { date: mention.date }),
		...(mention.time && { time: mention.time }),
		...(mention.timeText && { timeText: mention.timeText }),
		...(mention.place && { place: mention.place }),
		...(mention.notes && { notes: mention.notes }),
		...(mention.unsure && { unsure: mention.unsure }),
	};
}

/** The words of a name or a text, the way `resolvePeople` splits them. */
const nameWords = (value: string, locale: string) =>
	value
		.toLocaleLowerCase(locale)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => [...word].length > 1);

/**
 * The members a mention names (`ctx.people`), with one more doubt: when they are only the person
 * who shared it and the shared text writes no member's name, the model may have given it to the
 * sharer because nobody else was named, so it is not certain. "Note to self: my check-up" still
 * goes to the sharer, marked for a look; a fee nobody is named for is not silently theirs. When
 * files were read there is no text to check, so it is not certain either.
 */
export function peopleNamed(
	ctx: Pick<MentionContext, 'people' | 'sharer' | 'text' | 'members' | 'locale'>,
	mention: Pick<Mention, 'people' | 'forMe' | 'peopleGuessed'>,
): PeopleResult {
	const found = ctx.people(mention);
	const onlySharer = ctx.sharer !== null && found.ids.length === 1 && found.ids[0] === ctx.sharer;
	if (!onlySharer || !found.certain) return found;
	if (ctx.text === null) return { ...found, certain: false };
	const said = new Set(nameWords(ctx.text, ctx.locale));
	const namesSomeone = ctx.members.some((m) =>
		nameWords(m.displayName, ctx.locale).some((word) => said.has(word)),
	);
	return namesSomeone ? found : { ...found, certain: false };
}

/** A part of a text that states an amount of money: a currency sign, an amount with cents, or a currency code. */
const MONEY = /\p{Sc}|\d[.,]\d{2}(?!\d)|\d\s?[A-Z]{3}(?![\p{L}\p{N}])/u;

/**
 * Notes without the sentences that state an amount of money, for kinds whose notes keep none
 * (a household record's amounts are the family's to write down, never a guess copied from an
 * invoice). Sentences are split at a full stop or a semicolon before a space, or at a line break; an amount is a
 * currency sign, a number with two decimals ("189.00", "45,50") or a number with a three-letter
 * code ("15 EUR"), so a mileage ("62,300 km") or a batch number stays. Empty when nothing is left.
 */
export function withoutAmounts(notes: string): string {
	const kept = sentencesOf(notes)
		.filter((part) => !MONEY.test(part))
		.join('');
	let end = kept.length;
	while (end > 0 && (kept[end - 1] === ';' || SPACE.test(kept[end - 1] as string))) end--;
	return kept.slice(0, end).trim();
}

const SPACE = /\s/u;

/**
 * A text cut before each non-space character that follows a line break, or a full stop or a
 * semicolon and then spaces. One pass over the text, so a long run of spaces costs no more than
 * its length.
 */
function sentencesOf(text: string): string[] {
	const parts: string[] = [];
	let from = 0;
	// Whether the spaces just read follow a full stop or a semicolon.
	let afterStop = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (SPACE.test(ch)) {
			if (i > 0 && !SPACE.test(text[i - 1] as string))
				afterStop = text[i - 1] === '.' || text[i - 1] === ';';
			continue;
		}
		const prev = text[i - 1];
		if (i > 0 && (prev === '\n' || (afterStop && SPACE.test(prev as string)))) {
			parts.push(text.slice(from, i));
			from = i;
		}
	}
	parts.push(text.slice(from));
	return parts;
}

/**
 * The input fields of the slots a model marked `unsure`, by a kind's own map from slot to the
 * fields it fills. A slot the map leaves out marks nothing.
 */
export function unsureFields(
	mention: Pick<Mention, 'unsure'>,
	fields: Partial<Record<Slot, string | readonly string[]>>,
): string[] {
	const out = new Set<string>();
	for (const field of mention.unsure ?? []) {
		const slot = slotOfField(field);
		const of = slot === null ? undefined : fields[slot];
		for (const name of typeof of === 'string' ? [of] : (of ?? [])) out.add(name);
	}
	return [...out];
}

/**
 * Whether a shared text addresses everyone ("the whole family", "all of us"), by a catalog's
 * comma-separated everyone-words (`ctx.vocabulary`). Whole words only, case aside. A message that
 * does is stating the whole family, so a kind that gives an event to everyone is not guessing.
 */
export function addressesEveryone(
	text: string | null,
	everyoneWords: readonly string[],
	locale: string,
): boolean {
	if (text === null) return false;
	const split = (value: string) =>
		value
			.toLocaleLowerCase(locale)
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean);
	const said = ` ${split(text).join(' ')} `;
	return everyoneWords.some((phrase) => {
		const words = split(phrase);
		return words.length > 0 && said.includes(` ${words.join(' ')} `);
	});
}

/** The most characters of a mention's notes a resolver keeps. */
export const MENTION_NOTES_MAX = 2000;

/**
 * A mention left out, with the words naming what it was about (none: a blank line). `from` is the
 * mention's index, or every index of a merged resolution.
 */
export const refuse = (
	reason: RefusalReason,
	subject: string | null | undefined,
	from: number | readonly number[],
): Resolution => ({
	refuse: { reason, subject: subject ?? null, from: typeof from === 'number' ? [from] : from },
});

/** Whether two texts are the same words: case, edge spaces and runs of spaces do not matter. */
export const sameText = (a: string, b: string): boolean => {
	const plain = (s: string) => s.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
	return plain(a) === plain(b);
};
