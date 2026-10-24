import { languageName } from '@famos/i18n/names';
import {
	type Actor,
	type AiAreaAccess,
	type DigestOutput,
	type FamilyMember,
	type FamilySettings,
	type HandleTable,
	isLlmError,
	type JobContext,
	QUESTION_TOPICS,
	type QuestionTopic,
	resolveAskedPeople,
	resolveTopics,
	typedIdKind,
} from '@famos/sdk';
import {
	addDays,
	type DateOrder,
	type DateWords,
	type DayParts,
	dateLocale,
	namedMonths,
	namedWeekdays,
	type ResolvedSpan,
	resolveSpan,
	weekdayMismatches,
} from '@famos/time';
import { type AnswerCard, CHAT_FEATURE, type LeadCheck } from '../contract/index.ts';
import { LEAD_TIMEOUT_MS } from './budget.ts';
import { buildCard, type CardWords, cardText, type Fetched } from './card.ts';
import { checkLead, firstSentences, leadBudget, leadPrompt, leadSystem } from './lead.ts';
import type { RecordedCall } from './tools.ts';
import type { Question } from './understand.ts';

/**
 * The answer to a question, worked out by code: the days, the people and the topics from what
 * the model read, the facts from each topic's digest (read as the AI working for the asker), and
 * the card made of them. A model only words the opening, and code checks it.
 */

/**
 * The most words an opening keeps for anyone: two sentences that run on through every fact are
 * the card again, not an opening.
 */
const LEAD_MAX_WORDS = 50;

/** Topics whose answers another topic's facts complete: a dinner elsewhere is an event. */
const COMPANIONS: Partial<Record<QuestionTopic, QuestionTopic>> = { meals: 'calendar' };

/**
 * A day reference without the parts its own words do not give: a model that reads "this month"
 * as `month: 1` would otherwise ask about January. A month needs a month's name or a number in
 * the words, a weekday a weekday's name, a day number a digit. Words in no installed language
 * (or none at all) leave the reference as it is.
 */
export function partsTheWordsGive(ref: DayParts | undefined, words: DateWords | undefined) {
	if (!ref || !words || !ref.text?.trim() || ref.numeric) return ref;
	const text = ref.text;
	const digits = /\d/u.test(text);
	const out: DayParts = { ...ref };
	if (out.month !== undefined && !digits && namedMonths(text, words).length === 0) delete out.month;
	if (out.weekday !== undefined && namedWeekdays(text, words).length === 0) delete out.weekday;
	if (out.day !== undefined && !digits) delete out.day;
	return out;
}

/** The days a question is about; a question that names none is about the coming seven days. */
export function questionSpan(
	question: Pick<Question, 'span'>,
	today: string,
	weekStart: number,
	options: { order?: DateOrder; words?: DateWords } = {},
): ResolvedSpan {
	const span = question.span && {
		...question.span,
		day: partsTheWordsGive(question.span.day, options.words),
		from: partsTheWordsGive(question.span.from, options.words),
		to: partsTheWordsGive(question.span.to, options.words),
	};
	const found = span ? resolveSpan(span, today, weekStart, options) : null;
	if (found) return found;
	const to = addDays(today, 6);
	return { from: today, to, label: { key: 'coming_days', from: today, to } };
}

/** The topics asked about, each followed by the one that completes it. */
export function withCompanions(topics: readonly QuestionTopic[]): QuestionTopic[] {
	const out: QuestionTopic[] = [];
	for (const topic of topics) {
		if (!out.includes(topic)) out.push(topic);
		const companion = COMPANIONS[topic];
		if (companion && !out.includes(companion)) out.push(companion);
	}
	return out;
}

export interface TopicPlan {
	open: { topic: QuestionTopic; actionId: string }[];
	notHere: AnswerCard['notHere'];
	fallback: boolean;
	topics: QuestionTopic[];
}

/**
 * Which topics can be answered for the asker: those whose area is installed, open to the AI and
 * readable by the asker. The others become "not here" lines with why.
 */
export function planTopics(
	asked: readonly QuestionTopic[],
	actions: Pick<JobContext['actions'], 'aiDigests' | 'aiMissingAreas'>,
	actor: Actor,
	local: boolean,
): TopicPlan {
	const missing = new Map(actions.aiMissingAreas({ local }).map((m) => [m.id, m.why]));
	const open = actions.aiDigests({ local });
	const mine = new Map(actions.aiDigests({ local, actor }).map((d) => [d.topic, d.actionId]));
	const closed = [...missing].filter(([, why]) => why === 'closed_to_ai').map(([id]) => id);
	const installed = new Set([...open.map((d) => d.area), ...closed]);
	const access = (area: string): AiAreaAccess =>
		missing.get(area) === 'closed_to_ai' ? 'off' : 'any';
	const resolved = resolveTopics(withCompanions(asked), installed, access, { local: true });
	const notHere: AnswerCard['notHere'] = resolved.missing.map((m) => ({
		topic: m.topic,
		why: m.why,
	}));
	const readable: TopicPlan['open'] = [];
	for (const topic of resolved.open) {
		const actionId = mine.get(topic);
		if (actionId) readable.push({ topic, actionId });
		else if (open.some((d) => d.topic === topic)) notHere.push({ topic, why: 'not_allowed' });
		else notHere.push({ topic, why: 'not_installed' });
	}
	return {
		open: readable,
		notHere,
		fallback: resolved.fallback,
		topics: [...resolved.open, ...resolved.missing.map((m) => m.topic)],
	};
}

export interface QuestionInput {
	question: Question;
	/** The message as the person wrote it. */
	asked: string;
	member: FamilyMember;
	family: readonly FamilyMember[];
	settings: FamilySettings;
	today: string;
	actor: Actor;
	policy: { local: boolean; sendPeople: boolean };
	via: 'app' | 'chat';
	words: DateWords;
	order: DateOrder;
	/** The thread's handles, so a follow-up ("move it") can point at what the card showed. */
	table: HandleTable;
	labels: Map<string, string>;
	/** Members the question's earlier part, or else the thread's previous question, was about: whom a pronoun ("his") stands for. */
	carried?: readonly string[];
	jobId: string;
}

export interface QuestionAnswer {
	card: AnswerCard;
	/** The members the question was about, for a later part that says "his". */
	memberIds: string[];
	/** The opening words, when they passed the checks; else empty. */
	lead: string;
	calls: RecordedCall[];
}

/** Every day the card names, for checking the opening words against it. */
function cardDates(card: Omit<AnswerCard, 'text' | 'lead'>, today: string): Set<string> {
	const dates = new Set([card.understood.span.from, card.understood.span.to, today]);
	for (const section of card.sections)
		for (const item of [...section.items, ...(section.next ? [section.next] : [])]) {
			if (item.date) dates.add(item.date);
			if (item.endDate) dates.add(item.endDate);
		}
	return dates;
}

/** Answers a question as `QuestionInput.question` reads it. Throws a model's `LlmError` only from the wording call when it is worth another try. */
export async function answerQuestion(
	ctx: Pick<JobContext, 'actions' | 'llm' | 'translate' | 'vocabulary' | 'logger'>,
	input: QuestionInput,
): Promise<QuestionAnswer> {
	const { question, member, settings, actor } = input;
	const language = member.locale ?? settings.locale;
	const span = questionSpan(question, input.today, settings.weekStart, {
		order: input.order,
		words: input.words,
	});
	// A pronoun is no name: it stands for whom the question spoke of before, and with nobody
	// before it the question is about nobody in particular.
	const pronouns = new Set(
		ctx
			.vocabulary('assistant:words_pronouns')
			.flatMap((entry) => entry.toLocaleLowerCase(language).split(/[^\p{L}\p{N}]+/u)),
	);
	const isPronoun = (said: string) => {
		const parts = said
			.toLocaleLowerCase(language)
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean);
		return parts.length > 0 && parts.every((part) => pronouns.has(part));
	};
	const spoken = question.people.map((p) => p.said);
	const named = spoken.filter((said) => !isPronoun(said));
	const people = resolveAskedPeople(
		named,
		input.family,
		member.id,
		ctx.vocabulary('assistant:words_self'),
		{
			// "We" and "our" in a question are the family's: whose things, not a filter.
			everyoneWords: [
				...ctx.vocabulary('assistant:words_everyone'),
				...ctx.vocabulary('assistant:words_us'),
			],
			locale: language,
		},
	);
	if (named.length < spoken.length && people.ids.length === 0 && !people.everyone)
		for (const id of input.carried ?? []) people.ids.push(id);
	const plan = planTopics(question.topics, ctx.actions, actor, input.policy.local);
	const names = new Map(input.family.map((m) => [m.id, m.displayName]));
	const calls: RecordedCall[] = [];
	const fetched: Fetched[] = [];
	// A word for everyone with someone named ("do we need to pick up Noah") is about that person.
	const everyone = people.everyone && people.ids.length === 0;
	const memberIds = everyone || people.ids.length === 0 ? undefined : people.ids;
	for (const { topic, actionId } of plan.open) {
		const record: RecordedCall = { name: actionId, ok: false };
		calls.push(record);
		try {
			const result = await ctx.actions.invoke<DigestOutput>(
				actionId,
				{
					from: span.from,
					to: span.to,
					...(memberIds && { memberIds }),
					...(question.about?.length && { about: question.about }),
				},
				actor,
			);
			if (result.status !== 'applied') throw new Error('not applied');
			record.ok = true;
			fetched.push({
				topic,
				output: result.output,
				...(memberIds && { others: await othersOf(ctx, actionId, span, result.output, actor) }),
			});
		} catch (error) {
			// An area refused at the last moment (a role changed, the area closed) is not here.
			ctx.logger.warn(
				{ actionId, err: error instanceof Error ? error.name : 'unknown' },
				'digest read failed',
			);
			plan.notHere.push({ topic, why: 'not_allowed' });
		}
	}
	// What the card shows keeps its handles, so the next message can point at it.
	for (const { output } of fetched)
		for (const item of output.items) {
			const kind = item.handle ? typedIdKind(item.handle) : null;
			if (item.handle && kind) input.labels.set(input.table.add(kind, item.handle), item.title);
		}
	const facts = buildCard({
		topics: plan.topics,
		people: people.ids.map((id) => names.get(id)).filter((n): n is string => n !== undefined),
		everyone,
		unmatched: people.unmatched,
		span: span.label,
		fallback: plan.fallback,
		// A weekday that does not fit its date in what the person wrote is pointed out.
		mismatches: weekdayMismatches(input.asked, input.today, input.words, input.order).map((m) => ({
			date: m.date,
			said: m.saidWeekday,
		})),
		fetched,
		notHere: plan.notHere,
		names,
	});
	const words: CardWords = {
		t: (key, params) => ctx.translate(language, `assistant:${key}`, params),
		dateLocale: dateLocale(language, settings.formatLocale, settings.hourCycle),
		hourCycle: settings.hourCycle,
		today: input.today,
	};
	const text = cardText(facts, words);
	const { lead, check } = await wordLead(ctx, input, facts, text, words);
	return {
		card: { ...facts, lead: { kept: check === null, check }, text },
		memberIds: people.ids,
		lead,
		calls,
	};
}

/**
 * What the same days hold for other people, when the question was about some of them: only how
 * many, so the card can say there is more than the asker's ("2 more are for other people")
 * without showing it. A read that fails leaves the line out; it never fails the answer.
 */
async function othersOf(
	ctx: Pick<JobContext, 'actions' | 'logger'>,
	actionId: string,
	span: { from: string; to: string },
	theirs: DigestOutput,
	actor: Actor,
): Promise<{ count: number; more: boolean } | undefined> {
	try {
		const all = await ctx.actions.invoke<DigestOutput>(
			actionId,
			{ from: span.from, to: span.to },
			actor,
		);
		if (all.status !== 'applied') return undefined;
		const keyOf = (item: DigestOutput['items'][number]) =>
			item.handle ?? `${item.kind}|${item.date}|${item.time ?? ''}|${item.title}`;
		const shown = new Set(theirs.items.map(keyOf));
		const count = all.output.items.filter((item) => !shown.has(keyOf(item))).length;
		// A cut read cannot tell how many: it can only say that there are more.
		if (count === 0 && !all.output.truncated) return undefined;
		return { count, more: all.output.truncated };
	} catch {
		ctx.logger.warn({ actionId }, 'digest read for others failed');
		return undefined;
	}
}

async function wordLead(
	ctx: Pick<JobContext, 'llm' | 'vocabulary' | 'logger'>,
	input: QuestionInput,
	facts: Omit<AnswerCard, 'text' | 'lead'>,
	text: readonly string[],
	words: CardWords,
): Promise<{ lead: string; check: LeadCheck | null }> {
	const { member, settings, policy } = input;
	// Without names for the model, the facts it reads name nobody.
	const shown = policy.sendPeople
		? text
		: cardText(
				{
					...facts,
					understood: { ...facts.understood, people: [], unmatched: [] },
					sections: facts.sections.map((s) => ({
						...s,
						items: s.items.map((i) => ({ ...i, people: [] })),
						...(s.next && { next: { ...s.next, people: [] } }),
					})),
				},
				words,
			);
	const budget = leadBudget(member.about, input.via, ctx.vocabulary('assistant:words_age'));
	const areas = [
		'assistant',
		...new Set(facts.sections.map((s) => QUESTION_TOPICS[s.topic]).filter((a) => a !== 'core')),
	];
	let written: string;
	try {
		const result = await ctx.llm.chat({
			role: 'smart',
			feature: CHAT_FEATURE,
			areas,
			system: leadSystem({
				asker: policy.sendPeople ? { name: member.displayName, about: member.about } : null,
				language: languageName(member.locale ?? settings.locale),
				budget,
			}),
			messages: [{ role: 'user', content: leadPrompt({ question: input.asked, facts: shown }) }],
			tools: [],
			maxSteps: 1,
			temperature: 0,
			timeoutMs: LEAD_TIMEOUT_MS,
			memberId: member.id,
			jobId: input.jobId,
		});
		written = firstSentences(result.text.replace(/\s+/g, ' '), budget.sentences);
	} catch (error) {
		// The card is the answer; words that could not be had are only left out.
		ctx.logger.warn({ err: isLlmError(error) ? error.code : 'unknown' }, 'assistant lead failed');
		return { lead: '', check: 'failed' };
	}
	const check = checkLead(written, {
		dates: cardDates(facts, input.today),
		today: input.today,
		words: input.words,
		order: input.order,
		titles: facts.sections.flatMap((s) =>
			[...s.items, ...(s.next ? [s.next] : [])].map((i) => i.title),
		),
		known: [...text, input.asked, ...input.family.map((m) => m.displayName)],
		sections: facts.sections.map((s) => ({ topic: s.topic, empty: s.items.length === 0 })),
		fullTitles: facts.sections.flatMap((s) => s.items.map((i) => i.title)),
		maxWords: budget.words ?? LEAD_MAX_WORDS,
		nothing: ctx.vocabulary('assistant:words_nothing'),
		negations: ctx.vocabulary('assistant:words_no'),
		topicWords: Object.fromEntries(
			facts.sections.map((s) => [s.topic, ctx.vocabulary(`assistant:words_topic_${s.topic}`)]),
		),
		locale: member.locale ?? settings.locale,
	});
	return check === null ? { lead: written, check } : { lead: '', check };
}
