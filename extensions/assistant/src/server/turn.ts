import {
	type Actor,
	conversationAnswered,
	createHandleTable,
	defineEvent,
	defineJob,
	isLlmError,
	type JobContext,
	type LlmChatMessage,
	type MemberId,
} from '@famos/sdk';
import { dateLocale, dateWords, numericDateOrder, todayIn, zoned } from '@famos/time';
import { z } from 'zod';
import {
	type AnswerCard,
	CHANNELS,
	CHAT_FEATURE,
	deltaPayload,
	donePayload,
	SUMMARIZE_JOB,
	TURN_JOB,
} from '../contract/index.ts';
import { answerWithRealWeekdays, answerWithWordDates, dayInWords } from './answer-dates.ts';
import { formatWeekday } from './format.ts';
import { cardOf, spokenText } from './messages.ts';
import { systemPrompt, weekdayDates, weekdayNotes } from './prompt.ts';
import { answerQuestion } from './question.ts';
import {
	createHandleScrubber,
	scrubHandles,
	scrubRecordHandles,
	withoutToolMarkup,
} from './scrub.ts';
import { tables } from './store.ts';
import { scopeTools, scopeTopics } from './tool-scope.ts';
import {
	type AssistantTool,
	areaOf,
	chatTools,
	newLoopState,
	type Proposal,
	type RecordedCall,
	toolsClosed,
} from './tools.ts';
import {
	QUESTION_JSON_SCHEMA,
	type Question,
	QuestionSchema,
	understandPrompt,
	understandSystem,
} from './understand.ts';
import { readVocabularies } from './vocabulary.ts';

/** The most notes sent to the model, and the most characters of them. */
export const MEMORY_MAX_NOTES = 20;
export const MEMORY_MAX_CHARS_TOTAL = 1500;

/**
 * The member's notes, newest first, capped. Read as the AI working for that member, so core hands
 * over theirs and nobody else's.
 */
async function recallMemories(ctx: Pick<JobContext, 'actions'>, actor: Actor): Promise<string[]> {
	try {
		const result = await ctx.actions.invoke<{ text: string }[]>(
			'core.recallMemories',
			{ limit: MEMORY_MAX_NOTES },
			actor,
		);
		if (result.status !== 'applied') return [];
		const notes: string[] = [];
		let total = 0;
		for (const note of result.output) {
			if (total + note.text.length > MEMORY_MAX_CHARS_TOTAL) break;
			total += note.text.length;
			notes.push(note.text);
		}
		return notes;
	} catch {
		// Notes are a convenience: an answer is better than none.
		return [];
	}
}

export const assistantDelta = defineEvent('assistant.delta', deltaPayload);
export const assistantDone = defineEvent('assistant.done', donePayload);

/** Messages of a thread sent verbatim; older ones live in the summary. */
export const KEEP_VERBATIM = 12;
/** When this many messages are not summarised yet, the summariser runs. */
export const SUMMARIZE_AFTER = 30;
/** The most handles kept with a thread, and the most listed in the prompt. */
const MAX_REMEMBERED_HANDLES = 150;
const MAX_RECORDS_IN_PROMPT = 30;

type RememberedHandles = Record<string, { id: string; label: string }>;

const parseHandles = (json: string | null): RememberedHandles => {
	try {
		return json ? (JSON.parse(json) as RememberedHandles) : {};
	} catch {
		return {};
	}
};

/**
 * The fixed lines of an answer that made suggestions, one per suggestion ("Suggested, not added
 * yet: Add shopping items: Milk, Oat milk"). Built from the suggestions, not from the model's
 * words, so the answer can never claim something else.
 */
export function proposalLines(
	proposals: readonly Proposal[],
	translate: (key: string, params?: Record<string, unknown>) => string,
	/** A day in words, in the reader's date format ("Thursday, 22 October"). */
	dayInWords: (date: string) => string,
): string[] {
	return proposals.map((p) => {
		const title = p.titleKey ? translate(p.titleKey) : p.title;
		const named = p.subject ? `${title}: ${p.subject}` : title;
		// The day it is about stays in the line: "Add a task: Pack my kit for Thursday, 22 October".
		const what = p.date
			? translate('assistant:proposed_for', { what: named, date: dayInWords(p.date) })
			: named;
		return translate(p.automatic ? 'assistant:proposed_automatic' : 'assistant:proposed', {
			what,
		});
	});
}

const MAX_STEPS = 8;
const CHAT_TIMEOUT_MS = 120_000;
export const UNDERSTAND_TIMEOUT_MS = 60_000;
const UNDERSTAND_MAX_TOKENS = 1_500;
/** The person's earlier messages the reading of the latest one sees, for "and on Friday?". */
const EARLIER_FOR_READING = 2;

/**
 * One answer of the assistant. The message was stored by `assistant.sendMessage`; this job reads
 * what the message is first. A question is answered by code from the digests of its topics (the
 * answer card), with opening words a model writes and code checks; anything else gets the tool
 * loop with the tools the asking member may use, whose text streams to that member only.
 * Idempotent: a finished message is left alone, and a restarted turn starts the answer again.
 */
export const turnJob = defineJob({
	name: TURN_JOB,
	payload: z.object({
		threadId: z.string(),
		messageId: z.string(),
		via: z.enum(CHANNELS).optional(),
	}),
	timeoutMs: 240_000,
	maxAttempts: 2,
	lane: 'long',
	backoff: () => 5_000,
	async handle(ctx, { threadId, messageId, via }, run) {
		const db = tables(ctx.db);
		const reply = await db
			.selectFrom('assistant_messages')
			.selectAll()
			.where('id', '=', messageId)
			.executeTakeFirst();
		if (!reply || reply.status === 'done' || reply.status === 'failed') return;
		const thread = await db
			.selectFrom('assistant_threads')
			.selectAll()
			.where('id', '=', threadId)
			.executeTakeFirst();
		if (!thread) return;
		const memberId = thread.member_id;
		// Set once the handle table exists; keeps the handles shown in this turn for the next.
		let persistHandles: () => Promise<void> = async () => {};

		const finish = async (fields: {
			status: 'done' | 'failed';
			content?: string;
			suggested?: readonly string[];
			errorCode?: string | null;
			calls?: RecordedCall[];
			card?: AnswerCard;
		}) => {
			await persistHandles();
			await db
				.updateTable('assistant_messages')
				.set({
					status: fields.status,
					content: fields.content ?? '',
					suggested: fields.suggested?.length ? JSON.stringify(fields.suggested) : null,
					error_code: fields.errorCode ?? null,
					tool_calls: fields.calls?.length ? JSON.stringify(fields.calls) : null,
					card: fields.card ? JSON.stringify(fields.card) : null,
				})
				.where('id', '=', messageId)
				.execute();
			await ctx.events.emitTo(memberId, assistantDone, {
				threadId,
				messageId,
				status: fields.status,
			});
			// Channels outside the app wait for this answer by its id.
			await ctx.events.emitTo(memberId, conversationAnswered, { replyId: messageId });
		};

		const member = (await ctx.family.members()).find((m) => m.id === memberId);
		// Someone archived or demoted since asking gets no answer: the assistant never exceeds them.
		if (!member) return finish({ status: 'failed', errorCode: 'forbidden' });
		const asker: Actor = { kind: 'member', memberId: member.id as MemberId, roleId: member.roleId };
		if (!ctx.access.can(asker, 'assistant.use'))
			return finish({ status: 'failed', errorCode: 'forbidden' });

		const policy = await ctx.llm.policy(CHAT_FEATURE, 'smart');
		if (!policy.enabled) return finish({ status: 'failed', errorCode: 'disabled' });

		await db
			.updateTable('assistant_messages')
			.set({ status: 'streaming', content: '' })
			.where('id', '=', messageId)
			.execute();
		if (run.attempt > 1)
			await ctx.events.emitTo(memberId, assistantDelta, {
				threadId,
				messageId,
				text: '',
				reset: true,
			});

		const actor: Actor = {
			kind: 'ai',
			mode: 'conversation',
			source: 'assistant',
			// The suggestions of this conversation are its own; the person's others are not.
			sourceId: threadId,
			onBehalfOf: member.id as MemberId,
			roleId: member.roleId,
			// Results of local-only areas may reach the model only if it runs on the family's network.
			local: policy.local,
		};
		const history = await db
			.selectFrom('assistant_messages')
			.select(['role', 'content', 'suggested', 'card', 'created_at'])
			.where('thread_id', '=', threadId)
			.where('status', '=', 'done')
			.where('created_at', '<', reply.created_at)
			.orderBy('created_at', 'desc')
			.orderBy('id', 'desc')
			.limit(KEEP_VERBATIM)
			.execute();
		// The model reads its earlier answers with the app's suggestion lines, so it knows what it
		// suggested even when it wrote nothing else.
		const kept = history
			.map((m) => ({ role: m.role, content: spokenText(m) }))
			.filter((m) => m.content !== '')
			.reverse();
		const messages: LlmChatMessage[] = kept.map((m) => ({
			role: m.role === 'assistant' ? 'assistant' : 'user',
			content: m.content,
		}));
		while (messages[0]?.role === 'assistant') messages.shift();
		// What the asker may use: their capabilities and the AI sandbox filter the tools.
		const offered: AssistantTool[] = [
			...ctx.actions.aiReadTools({ local: policy.local, actor }).map((info) => ({
				actionId: info.id,
				kind: 'read' as const,
				info,
			})),
			...ctx.actions.aiCatalog({ local: policy.local, actor }).map((info) => ({
				actionId: info.id,
				kind: 'draft' as const,
				info,
			})),
		];

		// The member's own notes go into their own threads only, and only where the family lets
		// people's details reach the model (core is not an area; the privacy switch governs it).
		const memories = policy.sendPeople ? await recallMemories(ctx, actor) : [];

		const family = await ctx.family.members();
		// Handles shown in earlier turns of this thread keep their meaning.
		const remembered = parseHandles(thread.handles);
		const table = createHandleTable(
			Object.fromEntries(Object.entries(remembered).map(([handle, r]) => [handle, r.id])),
		);
		const labels = new Map(Object.entries(remembered).map(([handle, r]) => [handle, r.label]));
		const targets = new Map<string, string>();
		const loop = newLoopState();
		persistHandles = async () => {
			const kept = [...table.toId]
				.filter(([handle]) => !handle.startsWith('member:') && !handle.startsWith('draft:'))
				.slice(-MAX_REMEMBERED_HANDLES)
				.map(([handle, id]) => [handle, { id, label: labels.get(handle) ?? '' }] as const);
			await db
				.updateTable('assistant_threads')
				.set({ handles: JSON.stringify(Object.fromEntries(kept)) })
				.where('id', '=', threadId)
				.execute();
		};
		const handles = family.map((m) => ({ ...m, handle: table.add('member', m.id) }));
		const settings = await ctx.family.settings();
		const now = ctx.clock.now();
		const today = todayIn(settings.timeZone, now);
		// A weekday that does not fit its date in what the person just wrote is pointed out.
		const asked = kept.findLast((m) => m.role === 'user')?.content ?? '';
		const words = dateWords((key) => ctx.vocabulary(key));
		const order = numericDateOrder(settings.formatLocale);
		const notes = weekdayNotes(asked, today, words, order);
		const time = zoned(now, settings.timeZone).toPlainTime().toString({ smallestUnit: 'minute' });
		// Weekdays named without a date get their dates from code, the same way every time.
		const days = weekdayDates(asked, today, time, words, order);
		const locale = member.locale ?? settings.locale;

		// What the message is, read first: a question is answered from facts code fetched.
		let question: Question | null = null;
		try {
			const read = await ctx.llm.generateObject({
				role: 'smart',
				feature: CHAT_FEATURE,
				// Only the message: names, dates and the family's data are worked out by code.
				areas: ['assistant'],
				schema: QuestionSchema,
				jsonSchema: QUESTION_JSON_SCHEMA,
				system: understandSystem(),
				prompt: understandPrompt(
					asked,
					kept
						.filter((m) => m.role === 'user')
						.slice(0, -1)
						.slice(-EARLIER_FOR_READING)
						.map((m) => m.content),
				),
				timeoutMs: UNDERSTAND_TIMEOUT_MS,
				maxOutputTokens: UNDERSTAND_MAX_TOKENS,
				// The same message should be read the same way every time.
				temperature: 0,
				memberId,
				jobId: run.id,
			});
			question = read.output;
		} catch (error) {
			if (!isLlmError(error)) throw error;
			if (error.retryable && run.attempt < run.maxAttempts) {
				await db
					.updateTable('assistant_messages')
					.set({ status: 'pending', content: '' })
					.where('id', '=', messageId)
					.execute();
				throw error;
			}
			// A reading that could not be had in the last try (a broken or cut answer, a slow or
			// busy provider) leaves the message to the tool loop, which answers everything it did
			// before; a model the family must set up first (no model, a bad key, a limit) ends it.
			if (!error.retryable && error.code !== 'invalid_output' && error.code !== 'output_too_long')
				return finish({ status: 'failed', errorCode: error.code });
		}

		if (question?.intent === 'ask') {
			try {
				const answer = await answerQuestion(ctx, {
					question,
					asked,
					member,
					family,
					settings,
					today,
					actor,
					policy,
					via: via ?? 'app',
					words,
					order,
					table,
					labels,
					jobId: run.id,
				});
				if (answer.lead !== '')
					await ctx.events.emitTo(memberId, assistantDelta, {
						threadId,
						messageId,
						text: answer.lead,
						reset: true,
					});
				return await finish({
					status: 'done',
					content: answer.lead,
					card: answer.card,
					calls: answer.calls,
				});
			} catch (error) {
				ctx.logger.error(
					{ threadId, err: error instanceof Error ? error.name : 'unknown' },
					'assistant question failed',
				);
				return finish({ status: 'failed', errorCode: 'unavailable' });
			}
		}

		// A change or a thing to remember gets the tools of what it is about, plus those of what the
		// answer just before it was about ("yes, move it" after a card on the calendar); anything
		// else keeps every tool.
		const lastCard = cardOf(history.find((m) => m.role === 'assistant') ?? { card: null });
		const tools = scopeTools(
			offered,
			question?.intent ?? 'other',
			scopeTopics(question?.topics ?? [], lastCard?.sections.map((s) => s.topic) ?? []),
		);

		const vocabularies = await readVocabularies(
			ctx,
			actor,
			new Set(tools.filter((t) => t.kind === 'draft').map((t) => areaOf(t.actionId))),
		);
		const calls: RecordedCall[] = [];
		const proposals: Proposal[] = [];
		const inject = {
			'core.addMemory': { source: 'ai' },
		};
		// A handle in an answer becomes the member's name, or a neutral word where names are not shared.
		const nameOf = (handle: string) => {
			const id = table.toId.get(handle);
			const found = policy.sendPeople ? family.find((m) => m.id === id) : undefined;
			return (
				found?.displayName ?? ctx.translate(member.locale ?? settings.locale, 'assistant:someone')
			);
		};
		const scrubber = createHandleScrubber(nameOf);
		const emit = (text: string) => {
			if (text !== '')
				void ctx.events.emitTo(memberId, assistantDelta, { threadId, messageId, text });
		};

		try {
			const result = await ctx.llm.chat({
				role: 'smart',
				feature: CHAT_FEATURE,
				areas: ['assistant', ...new Set(tools.map((t) => areaOf(t.actionId)))],
				system: systemPrompt({
					today,
					weekday: formatWeekday(today),
					now: time,
					weekStart: settings.weekStart,
					timeZone: settings.timeZone,
					// The asker's own language, else the family's.
					locale: member.locale ?? settings.locale,
					hourCycle: settings.hourCycle,
					asker: policy.sendPeople
						? { name: member.displayName, handle: table.handleOf(member.id) as string }
						: null,
					members: policy.sendPeople
						? handles.map((m) => ({ handle: m.handle, name: m.displayName, about: m.about }))
						: null,
					summary: thread.summarized_count > 0 ? thread.summary : null,
					hasTools: tools.length > 0,
					memories,
					records: [...labels]
						.filter(([, label]) => label !== '')
						.slice(-MAX_RECORDS_IN_PROMPT)
						.map(([handle, label]) => ({ handle, label })),
					notes,
					days,
					areas: [...new Set(tools.map((t) => areaOf(t.actionId)))],
					missing: ctx.actions.aiMissingAreas({ local: policy.local }),
					vocabularies,
				}),
				messages,
				tools: chatTools(tools, {
					actions: ctx.actions,
					actor,
					table,
					turnId: messageId,
					calls,
					proposals,
					labels,
					targets,
					inject,
					translate: (key) => ctx.translate(member.locale ?? settings.locale, key),
					onFailure: ({ actionId, code, inputKeys }) =>
						ctx.logger.warn({ actionId, code, inputKeys }, 'assistant tool call failed'),
					// Names are matched here, at home, so this works when names are not sent too.
					people: family,
					locale: settings.locale,
					loop,
					// A note to remember says what the person said, not what the model guessed.
					grounded: { 'core.addMemory': 'text' },
					// A change takes people only when the latest message names them.
					asked: {
						text: asked,
						memberId: member.id,
						self: ctx.vocabulary('assistant:words_self'),
						everyone: ctx.vocabulary('assistant:words_everyone'),
					},
					said: [
						...kept.filter((m) => m.role === 'user').map((m) => m.content),
						...family.map((m) => m.displayName),
					].join('\n'),
					// What the person read too: a "yes" to "did you mean …?" names the thing that way.
					heard: kept.map((m) => m.content).join('\n'),
				}),
				maxSteps: MAX_STEPS,
				// The same question should get the same lookups and suggestions: at the provider's
				// default the model picks different tools (or none) from one run to the next.
				temperature: 0,
				toolsClosed: () => toolsClosed(calls, loop),
				timeoutMs: CHAT_TIMEOUT_MS,
				memberId,
				jobId: run.id,
				onText: (text) => emit(scrubber.push(text)),
			});
			emit(scrubber.flush());
			// Whatever the model wrote, the person is told what was really suggested, from the
			// suggestions themselves. The lines are kept beside the answer, not in it: the app shows
			// the suggestions as cards, and a chat outside it gets the lines under the words.
			const readerDates = dateLocale(locale, settings.formatLocale, settings.hourCycle);
			const suggested = proposalLines(
				proposals,
				(key, params) => ctx.translate(locale, key, params),
				(date) => dayInWords(date, today, readerDates),
			);
			// A model can end the loop with no words (the last step is kept for an answer, but it may
			// say nothing). If the turn made suggestions, the lines naming them are the answer (asking
			// again would suggest them twice); with nothing at all it is a failure.
			const written = result.text ? scrubHandles(result.text, nameOf) : '';
			// A weekday the answer puts next to a date of another weekday is the model's slip: the
			// date comes from a tool. The stored answer says the real one, and so does the stream.
			// An ISO date it copied from a tool is written as words, in the reader's date format.
			// Tool calls a model wrote out as text on the step that had no tools are no answer, and a
			// record's handle in the words becomes the record's title.
			const clean = scrubRecordHandles(withoutToolMarkup(written), (handle) =>
				table.toId.has(handle)
					? labels.get(handle) || ctx.translate(locale, 'assistant:something')
					: null,
			);
			const answer = answerWithWordDates(
				answerWithRealWeekdays(clean, {
					today,
					words,
					order,
					asked,
					locales: [locale, settings.locale, 'en'],
					translate: (lng, key) => ctx.translate(lng, key),
				}),
				{
					today,
					asked,
					dateLocale: readerDates,
					weekdays: [...words.weekdays.flat(), ...words.weekdaysShort.flat()],
				},
			);
			if (answer !== written)
				await ctx.events.emitTo(memberId, assistantDelta, {
					threadId,
					messageId,
					text: answer,
					reset: true,
				});
			await finish(
				answer === '' && suggested.length === 0
					? { status: 'failed', errorCode: 'no_answer', calls }
					: { status: 'done', content: answer, suggested, calls },
			);
			const total = await db
				.selectFrom('assistant_messages')
				.select((eb) => eb.fn.countAll<number>().as('n'))
				.where('thread_id', '=', threadId)
				.where('status', '=', 'done')
				.executeTakeFirstOrThrow();
			if (Number(total.n) - thread.summarized_count > SUMMARIZE_AFTER)
				await ctx.enqueue(
					SUMMARIZE_JOB,
					{ threadId },
					{ dedupeKey: `summarize:${threadId}`, maxAttempts: 3 },
				);
		} catch (error) {
			if (isLlmError(error)) {
				if (error.retryable && run.attempt < run.maxAttempts) {
					await db
						.updateTable('assistant_messages')
						.set({ status: 'pending', content: '' })
						.where('id', '=', messageId)
						.execute();
					throw error;
				}
				return finish({ status: 'failed', errorCode: error.code, calls });
			}
			// Never log the conversation: the error alone says what went wrong.
			ctx.logger.error(
				{ threadId, err: error instanceof Error ? error.name : 'unknown' },
				'assistant turn failed',
			);
			return finish({ status: 'failed', errorCode: 'unavailable', calls });
		}
	},
});
