import { languageName } from '@famos/i18n/names';
import {
	type Actor,
	type AiContext,
	AiContextSchema,
	type AiKindInfo,
	type FamosError,
	type IndexedMention,
	isFamosError,
	isLlmError,
	type JobContext,
	type LlmFile,
	type Mention,
	type MentionProposal,
	type MentionRecord,
	type ModelRole,
	namedShares,
	type ParsedUnderstanding,
	type ProposalRefusalDetails,
	parseUnderstanding,
	refusalOf,
	type SettledResolution,
	subjectOf,
} from '@famos/sdk';
import { clockTimes, formatDate, todayIn } from '@famos/time';
import { z } from 'zod';
import { EXTRACT_FEATURE, type ExtractionKind, type Skip } from '../../contract/index.ts';
import { coverage, locate, overlaps, type Span, wordsOf as spanWords } from './evidence.ts';
import {
	type KnownGroup,
	MAX_KNOWN,
	PROMPT_VERSION,
	promptHash,
	sharedItemPrompt,
	systemPrompt,
	understandingJsonSchema,
} from './prompt.ts';

/*
 * How Quick add reads one shared item: the model reads the message into mentions (a kind and a
 * few slots each, names as names and days as words); each kind's own extension resolves its
 * mentions into suggestions or refusals; the host checks what no extension can (is the mention
 * in the message at all, does a note name a person the message never names) and drafts the
 * suggestions as the AI. Inbox names no kind and no action: they come from the registry.
 */

/**
 * The most tokens one reading may write. A mention is about 30 to 80 tokens and an answer holds
 * at most `MENTION_LIMIT` of them; models that count their reasoning against the cap need room
 * on top. Anything longer is a model that has lost its way.
 */
export const EXTRACT_MAX_OUTPUT_TOKENS = 2_000;

const AI_ACTOR = { kind: 'ai', mode: 'share', source: 'inbox' } as const;

/** Confidence stored with a draft: kept for comparing readings, never shown. */
const SURE = 1;
const UNSURE = 0.6;

const SUMMARY_MAX = 80;

/**
 * The model's label, tidied: one line, no closing full stop, question or exclamation mark (it is
 * shown as a heading), and cut at a word boundary when it runs long.
 */
export function tidySummary(raw: string): string | null {
	const text = raw
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[\s.!?。？！]+$/u, '');
	if (text.length <= SUMMARY_MAX) return text || null;
	const cut = text.slice(0, SUMMARY_MAX - 1);
	const space = cut.lastIndexOf(' ');
	return `${(space > SUMMARY_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * Puts the items the shared text names first (by the share of their words it says, rare words
 * counting more), in that order, and the rest after them as they came (newest or soonest first).
 * The model sees only the first items of a long area, so what the item is about must not be cut.
 */
export function rankByMention<T extends { label: string }>(items: readonly T[], text: string): T[] {
	if (items.length < 2 || !text.trim()) return [...items];
	const shares = namedShares(
		text,
		items.map((item) => item.label),
	);
	const named = items
		.map((item, i) => ({ item, i, share: shares[i] ?? 0 }))
		.filter((entry) => entry.share > 0)
		.toSorted((a, b) => b.share - a.share || a.i - b.i);
	const rest = items.filter((_, i) => (shares[i] ?? 0) <= 0);
	return [...named.map((entry) => entry.item), ...rest];
}

/** What one area tells the model, and the records it lists for the resolvers. */
export interface RecordContext {
	/** The `ai.context` action it was read with. */
	from: string;
	kind: string;
	label: string;
	/** Words to write as they are (the family's tags), not records. */
	plain?: true;
	items: { id: string; label: string; details?: string; url?: string }[];
}

/**
 * What the areas of the offered kinds share with the model (`ai.context` of an extension). Each
 * is read through its read-only action as the AI actor, so an area that is off for the AI refuses
 * and contributes nothing; nothing here reads another extension's tables. When an area has more
 * than fit, the ones the shared `text` names come first.
 */
export async function readRecordContexts(
	ctx: Pick<JobContext, 'actions' | 'logger'>,
	areas: ReadonlySet<string>,
	text = '',
	actor: Actor = AI_ACTOR,
): Promise<RecordContext[]> {
	const groups: RecordContext[] = [];
	for (const [extensionId, actionIds] of ctx.actions.aiContextActions()) {
		if (!areas.has(extensionId)) continue;
		for (const actionId of actionIds) {
			let context: AiContext;
			try {
				const result = await ctx.actions.invoke(actionId, {}, actor);
				const parsed = AiContextSchema.safeParse(
					result.status === 'applied' ? result.output : null,
				);
				if (!parsed.success) continue;
				context = parsed.data;
			} catch (error) {
				// Locked, switched off or failing: the area simply tells the model nothing.
				if (!isFamosError(error)) ctx.logger.warn({ actionId }, 'AI context failed');
				continue;
			}
			const ranked = context.plain ? context.items : rankByMention(context.items, text);
			const items = ranked.slice(0, MAX_KNOWN);
			if (items.length > 0)
				groups.push({
					from: actionId,
					kind: context.kind,
					label: context.label,
					...(context.plain && { plain: true as const }),
					items,
				});
		}
	}
	return groups;
}

/** What a proposal is about in its own words ("Ice cream"), or null when it names nothing. */
const subjectIn = (input: unknown): string | null => subjectOf(JSON.stringify(input ?? {})) ?? null;

/**
 * Why the actions refused a suggestion, as the person reads it, in the reasons every AI surface
 * shares (`refusalOf`). The subject is the real title of what it pointed at when the runner knows
 * it, else the suggestion's own words.
 */
export function skipOf(
	error: Pick<FamosError, 'code' | 'details'>,
	input: unknown,
	subject: string | null = null,
): Skip {
	const refusal =
		error.code === 'conflict'
			? (error.details as Partial<ProposalRefusalDetails> | null | undefined)
			: undefined;
	const named = refusal?.subject?.trim() || subject || subjectIn(input);
	return { reason: refusalOf(error), subject: named };
}

/** `path: message` pairs from a treeified Zod error, for diagnostics without values. */
function issuePaths(tree: unknown, prefix = ''): string[] {
	if (!tree || typeof tree !== 'object') return [];
	const node = tree as {
		errors?: string[];
		properties?: Record<string, unknown>;
		items?: unknown[];
	};
	const here = (node.errors ?? []).map((m) => `${prefix || '(root)'}: ${m}`);
	const props = Object.entries(node.properties ?? {}).flatMap(([k, v]) =>
		issuePaths(v, prefix ? `${prefix}.${k}` : k),
	);
	const items = (node.items ?? []).flatMap((v, i) => issuePaths(v, `${prefix}[${i}]`));
	return [...here, ...props, ...items].slice(0, 20);
}

/** Letters-and-digits words, lower-cased in the family language. */
const wordsOf = (value: string, locale: string) =>
	value.toLocaleLowerCase(locale).match(/[\p{L}\p{N}]+/gu) ?? [];

/** A word that can say what something is: three letters or more, not a bare number. */
const telling = (word: string) => [...word].length > 2 && !/^\p{N}+$/u.test(word);

/** Shortest start two forms of one word share ("ücreti" and "ücretini", "trip" and "trips"). */
const MIN_STEM = 4;

function sameStem(a: string, b: string): boolean {
	if (a === b) return true;
	const [short, long] = [...a].length <= [...b].length ? [a, b] : [b, a];
	return [...short].length >= MIN_STEM && long.startsWith(short);
}

/** How a mention rests on the shared message's words (`grounding`). */
export type Grounding =
	/** Words of what it names (its title, target or record) are in the message. */
	| 'named'
	/** Only the words of its day, time or place are. */
	| 'placed'
	/** It has words, and none of them is in the message. */
	| 'none'
	/** It has no words to check; its resolver refuses it as incomplete. */
	| 'empty';

/**
 * How a mention rests on the shared message: whether some telling word of what it names appears
 * in the message, in any form that starts the same ("gezi" and "gezisi"), or else the words of
 * its day, time or place do. Words are the message's own data, so this works in any language.
 */
export function grounding(mention: Mention, text: string, locale: string): Grounding {
	const said = wordsOf(text, locale).filter((w) => [...w].length > 1);
	const plainText = text.toLocaleLowerCase(locale).replace(/\s+/gu, ' ');
	const names = (value: string | undefined) => {
		if (!value?.trim()) return null;
		const words = wordsOf(value, locale).filter(telling);
		if (words.length === 0)
			return plainText.includes(value.trim().toLocaleLowerCase(locale).replace(/\s+/gu, ' '));
		return words.some((w) => said.some((s) => sameStem(w, s)));
	};
	const subject = [mention.title, mention.target, mention.about].map(names);
	if (subject.some((found) => found === true)) return 'named';
	const around = [mention.date?.text, mention.timeText, mention.place].map(names);
	if (around.some((found) => found === true)) return 'placed';
	return [...subject, ...around].every((found) => found === null) ? 'empty' : 'none';
}

/**
 * The places (in `mentions`) of the mentions the shared message does not hold: the model's own
 * inventions, or what text in the message told it to make up. Neither becomes a suggestion.
 * A mention whose quote the message writes (`quoted`) rests on it. Otherwise its words are
 * checked: titles are written in the family language, which may not be the message's, so when
 * not one mention is quoted or has its title, target or record in the message, the reading was
 * translated and no title can be checked against it; then only each kind's limit holds it.
 */
export function ungrounded(
	mentions: readonly Mention[],
	text: string,
	locale: string,
	quoted: readonly boolean[] = [],
): Set<number> {
	const found = mentions.map((m, i) => (quoted[i] ? 'named' : grounding(m, text, locale)));
	if (!found.includes('named')) return new Set();
	return new Set(found.flatMap((g, i) => (g === 'none' ? [i] : [])));
}

/**
 * When the sentences that speak to the machine cover this much of a message, the message is the
 * sharer's own request ("FamilyOS, add milk"), not something written into what they forwarded.
 */
const OWN_REQUEST = 0.8;

/** Where a reading rests in the shared message, as `placeReading` finds it. */
export interface Placed {
	/** Each mention's own words in the message (its quote, else its title or target), or null. */
	evidence: (Span | null)[];
	/** Whether the evidence is the mention's quote. */
	quoted: boolean[];
	/** The mentions that rest on words written to the machine inside the message. */
	instructions: Set<number>;
	/** The mentions whose notes are another mention's thing, to be left out of them. */
	foreignNotes: Set<number>;
}

/**
 * Where each mention rests in the shared message, by the words the model copied:
 * - A mention resting on a sentence that speaks to FamilyOS or an AI (`addressed`) is an
 *   instruction written into the message, not something it states, unless such sentences are
 *   nearly all of it (the sharer telling FamilyOS what to add). Its quote decides; without one,
 *   where the message writes its title or target.
 * - Notes that repeat what another mention of the reading is about ("Bring the football kit" as
 *   the notes of a dentist visit, next to a task of that name), and that its own quote does not
 *   hold, belong to that other mention.
 */
export function placeReading(
	mentions: readonly Mention[],
	addressed: readonly string[],
	text: string,
	locale: string,
): Placed {
	const quotes = mentions.map((m) => (m.quote ? locate(m.quote, text, locale) : null));
	const evidence = mentions.map((m, i) => {
		const words = m.title ?? m.target;
		return quotes[i] ?? (words ? locate(words, text, locale) : null);
	});
	const spoken = addressed
		.map((line) => locate(line, text, locale))
		.filter((span): span is Span => span !== null);
	const own = coverage(spoken, text, locale) >= OWN_REQUEST;
	const instructions = new Set<number>();
	if (!own)
		evidence.forEach((span, i) => {
			if (span && spoken.some((s) => overlaps(s, span))) instructions.add(i);
		});
	const foreignNotes = new Set<number>();
	mentions.forEach((m, i) => {
		const quote = quotes[i];
		if (!m.notes?.trim() || !quote) return;
		const notes = locate(m.notes, text, locale);
		if (notes && overlaps(notes, quote)) return;
		const elsewhere = mentions.some((other, j) => {
			const about = other.title ?? other.target;
			return j !== i && about !== undefined && (namedShares(m.notes ?? '', [about])[0] ?? 0) > 0.5;
		});
		if (elsewhere) foreignNotes.add(i);
	});
	return { evidence, quoted: quotes.map((q) => q !== null), instructions, foreignNotes };
}

/** One mention per thing: an exact repeat of one is the model saying it twice. */
const keyOf = (mention: Mention) =>
	JSON.stringify(Object.entries(mention).toSorted(([a], [b]) => a.localeCompare(b)));

/**
 * Input fields (top level) that hold a mention's notes or tags and name a member the shared text
 * never names: the model guessed who it is for and wrote the guess down as a fact ("For Ivy").
 * Judged on the values, so no field is named here; names are the family's own data.
 */
export function guessedNamesIn(
	input: unknown,
	mention: Mention,
	members: readonly { displayName: string }[],
	text: string,
	locale: string,
): string[] {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
	const said = new Set(wordsOf(text, locale));
	const guessed = members
		.map((m) => wordsOf(m.displayName, locale).filter((w) => [...w].length > 1))
		.filter((words) => words.length > 0 && !words.some((w) => said.has(w)));
	if (guessed.length === 0) return [];
	const notes = mention.notes?.trim().toLocaleLowerCase(locale) ?? '';
	const tags = new Set((mention.tags ?? []).map((t) => t.trim().toLocaleLowerCase(locale)));
	const fields: string[] = [];
	for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
		const values = (Array.isArray(value) ? value : [value]).filter(
			(v): v is string => typeof v === 'string',
		);
		const holds = values.some((v) => {
			const lower = v.trim().toLocaleLowerCase(locale);
			return (notes !== '' && lower.startsWith(notes.slice(0, 40))) || tags.has(lower);
		});
		if (!holds) continue;
		const words = new Set(values.flatMap((v) => wordsOf(v, locale)));
		if (guessed.some((name) => name.some((w) => words.has(w)))) fields.push(field);
	}
	return fields;
}

/** The answer, as the adapter hands it over: the parser reads it, so any JSON goes. */
const AnswerSchema = z.unknown();

export interface ReadingInput {
	/** The item's text, as normalized (voice notes and text files included). */
	text: string;
	/** Images and PDFs the model reads itself. */
	files: readonly LlmFile[];
	/** Names of attached files the model cannot read here, and how many were not shared. */
	unreadable: readonly string[];
	withheld: number;
	channel: string;
	itemId: string;
	extraction: number;
	sharer: string | null;
	role: ModelRole;
	/** The model that reads runs on the family's own network. */
	local: boolean;
	sendPeople: boolean;
	/** The configured model's key, for an answer that was cut off and has no result. */
	model: string | null;
	jobId: string;
	/** No try of the reading comes after this one. */
	lastTry: boolean;
}

export interface Reading {
	summary: string | null;
	kind: ExtractionKind | null;
	model: string | null;
	drafted: number;
	skips: Skip[];
}

/** The model's answer read, also when the answer was cut off at the output cap. */
async function askModel(
	ctx: JobContext,
	input: ReadingInput,
	kinds: readonly AiKindInfo[],
	system: string,
): Promise<{ parsed: ParsedUnderstanding; model: string | null } | null> {
	const prompt = sharedItemPrompt(input);
	const ids = kinds.map((k) => k.id);
	const read = (raw: unknown) => parseUnderstanding(raw, ids, { clockTimes });
	try {
		const result = await ctx.llm.generateObject({
			role: input.role,
			feature: EXTRACT_FEATURE,
			// The inbox itself, and every area whose kinds the model may read.
			areas: ['inbox', ...new Set(kinds.map((k) => k.extension))],
			schema: AnswerSchema,
			jsonSchema: understandingJsonSchema(ids),
			system,
			prompt,
			files: [...input.files],
			timeoutMs: 90_000,
			maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
			// Reading facts out of a message: the same message should give the same mentions.
			temperature: 0,
			...(input.sharer && { memberId: input.sharer }),
			jobId: input.jobId,
		});
		const parsed = read(result.output);
		return parsed ? { parsed, model: result.model } : null;
	} catch (error) {
		// Cut off at the cap, or not JSON on the last try (a stray or missing character that
		// asking again did not mend): the complete mentions in the text still count. Before the
		// last try a broken answer is asked again instead, which mostly comes back whole.
		if (
			isLlmError(error) &&
			(error.code === 'output_too_long' || (error.code === 'invalid_output' && input.lastTry))
		) {
			const text = (error.cause as { text?: unknown } | undefined)?.text;
			const parsed = typeof text === 'string' ? read(text) : null;
			if (parsed && parsed.mentions.length + parsed.skips.length > 0)
				return { parsed: { ...parsed, truncated: true }, model: input.model };
		}
		throw error;
	}
}

/**
 * Reads one item into drafts. With no kind offered (every area off for the AI, or none
 * installed) the model is not asked. Throws what the model call throws; the job decides whether
 * to retry.
 */
export async function readItem(ctx: JobContext, input: ReadingInput): Promise<Reading> {
	const kinds = ctx.actions.aiKinds({ local: input.local });
	const reading: Reading = { summary: null, kind: null, model: null, drafted: 0, skips: [] };
	if (kinds.length === 0) return reading;

	const settings = await ctx.family.settings();
	const today = todayIn(settings.timeZone, ctx.clock.now());
	const family = await ctx.family.members();
	const sharer = family.find((m) => m.id === input.sharer) ?? null;
	// As the AI that reads: a local model may also be told what local-only areas hold.
	const actor: Actor = { ...AI_ACTOR, ...(input.local && { local: true }) };
	const contexts = await readRecordContexts(
		ctx,
		new Set(kinds.map((k) => k.extension)),
		input.text,
		actor,
	);
	const known: KnownGroup[] = contexts.map((group) => ({
		from: group.from,
		label: group.label,
		items: group.items,
	}));
	const records: MentionRecord[] = contexts
		.filter((group) => !group.plain)
		.flatMap((group) =>
			group.items.map((item) => ({
				kind: group.kind,
				id: item.id,
				label: item.label,
				...(item.url !== undefined && { url: item.url }),
			})),
		);
	const system = systemPrompt({
		kinds,
		weekday: formatDate(today, 'en', { weekday: 'long' }),
		today,
		timeZone: settings.timeZone,
		language: languageName(settings.locale),
		// Without consent to share people, the model sees no names; names the message itself
		// writes are still matched to members here, at home.
		members: input.sendPeople
			? family.map((m) => ({ displayName: m.displayName, about: m.about ?? null }))
			: null,
		sharer: input.sendPeople && sharer ? sharer.displayName : null,
		known,
	});

	const answer = await askModel(ctx, input, kinds, system);
	if (!answer) return reading;
	const { parsed, model } = answer;
	reading.summary = tidySummary(parsed.label);
	reading.kind = parsed.intent;
	reading.model = model;
	for (const skip of parsed.skips)
		reading.skips.push({ reason: skip.reason, subject: skip.subject });
	for (let i = 0; i < parsed.overflow; i++)
		reading.skips.push({ reason: 'incomplete', subject: null });
	// Cut off: what came after the cut is lost, and the person is told something is missing.
	if (parsed.truncated) reading.skips.push({ reason: 'incomplete', subject: null });

	// Files are read by the model alone: what it read from them cannot be checked against text.
	const text = input.files.length > 0 ? null : input.text;
	const locale = settings.locale;
	const seen = new Set<string>();
	const groups = new Map<string, IndexedMention[]>();
	const read = parsed.mentions.map((m) => m.mention);
	const placed = text === null ? null : placeReading(read, parsed.addressed, text, locale);
	const invented =
		text === null ? new Set<number>() : ungrounded(read, text, locale, placed?.quoted);
	/** The message's own words each mention rests on, by its place in the answer. */
	const quoteOf = new Map<number, string>();
	for (const [at, { index, mention, dropped: lost }] of parsed.mentions.entries()) {
		const key = keyOf(mention);
		if (seen.has(key)) continue;
		seen.add(key);
		const subject = mention.title ?? mention.target ?? null;
		if (invented.has(at)) {
			ctx.logger.info({ itemId: input.itemId, kind: mention.kind }, 'mention not in the message');
			reading.skips.push({ reason: 'incomplete', subject });
			continue;
		}
		if (placed?.instructions.has(at)) {
			ctx.logger.info(
				{ itemId: input.itemId, kind: mention.kind },
				'mention rests on words written to the AI',
			);
			reading.skips.push({ reason: 'instruction', subject });
			continue;
		}
		const span = placed?.quoted[at] ? placed.evidence[at] : null;
		if (span && text !== null) quoteOf.set(index, spanWords(span, text));
		// A field the parser had to drop was in the answer but unusable: what the resolver makes
		// of the rest is marked for a look where that field would have gone.
		let marked =
			lost.length > 0
				? { ...mention, unsure: [...new Set([...(mention.unsure ?? []), ...lost])] }
				: mention;
		if (placed?.foreignNotes.has(at)) {
			const { notes: _notes, ...rest } = marked;
			marked = rest;
		}
		const group = groups.get(mention.kind) ?? [];
		group.push({ index, mention: marked });
		groups.set(mention.kind, group);
	}

	const env = { text, sharer: input.sharer, records };
	const resolved: {
		resolution: SettledResolution;
		mentions: Mention[];
		from: readonly number[];
	}[] = [];
	for (const [kindId, mentions] of groups) {
		const byIndex = new Map(mentions.map((m) => [m.index, m.mention]));
		const out = await ctx.actions.resolveMentions(kindId, mentions, env, actor);
		for (const resolution of out) {
			const from = 'propose' in resolution ? resolution.propose.from : resolution.refuse.from;
			resolved.push({
				resolution,
				mentions: from.map((i) => byIndex.get(i)).filter((m): m is Mention => m !== undefined),
				from,
			});
		}
	}
	const first = (r: SettledResolution) => Math.min(...('propose' in r ? r.propose : r.refuse).from);
	resolved.sort((a, b) => first(a.resolution) - first(b.resolution));

	const hash = promptHash(kinds);
	for (const [i, { resolution, mentions, from }] of resolved.entries()) {
		if ('refuse' in resolution) {
			reading.skips.push({ reason: resolution.refuse.reason, subject: resolution.refuse.subject });
			continue;
		}
		const proposal: MentionProposal = resolution.propose;
		const uncertain = new Set(proposal.uncertain ?? []);
		if (text !== null)
			for (const mention of mentions)
				for (const field of guessedNamesIn(proposal.input, mention, family, text, locale))
					uncertain.add(field);
		const quote = [...new Set(from.flatMap((at) => quoteOf.get(at) ?? []))].join(' … ');
		try {
			await ctx.actions.invoke(proposal.actionId, proposal.input, actor, {
				draft: {
					...(quote && { quote }),
					sourceKind: 'inbox',
					sourceId: input.itemId,
					...(input.sharer && { forMember: input.sharer }),
					...(reading.summary && { summary: reading.summary }),
					...(model && { model }),
					promptVersion: `${PROMPT_VERSION}+${hash}`,
					confidence: uncertain.size > 0 ? UNSURE : SURE,
					uncertainFields: [...uncertain],
					dedupeKey: `inbox:${input.itemId}:${input.extraction}:${i}`,
				},
			});
			reading.drafted++;
		} catch (error) {
			// An input the action rejects, or a suggestion it refuses (a conflict: already done,
			// nothing would change), is dropped; the item says which, and why.
			if (
				isFamosError(error) &&
				(error.code === 'bad_request' || error.code === 'forbidden' || error.code === 'conflict')
			) {
				reading.skips.push(skipOf(error, proposal.input, proposal.subject));
				// Field paths and messages only, never values: they come from family content.
				ctx.logger.info(
					{
						itemId: input.itemId,
						action: proposal.actionId,
						code: error.code,
						issues: issuePaths(error.details),
					},
					'proposal skipped',
				);
				continue;
			}
			throw error;
		}
	}
	return reading;
}
