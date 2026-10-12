import {
	type Actor,
	createHandleTable,
	defineEvent,
	defineJob,
	isLlmError,
	type JobContext,
	type LlmChatMessage,
	type MemberId,
} from '@famos/sdk';
import { todayIn, zoned } from '@famos/time';
import { z } from 'zod';
import {
	CHAT_FEATURE,
	deltaPayload,
	donePayload,
	SUMMARIZE_JOB,
	TURN_JOB,
} from '../contract/index.ts';
import { formatWeekday } from './format.ts';
import { systemPrompt } from './prompt.ts';
import { createHandleScrubber, scrubHandles } from './scrub.ts';
import { tables } from './store.ts';
import {
	type AssistantTool,
	areaOf,
	chatTools,
	type Proposal,
	type RecordedCall,
	toolsClosed,
} from './tools.ts';

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
 * The fixed lines under an answer that made suggestions, one per suggestion ("Suggested: Add shopping
 * items: Milk, Oat milk"). Built from the suggestions, not from the
 * model's words, so the answer can never claim something else.
 */
export function proposalLines(
	proposals: readonly Proposal[],
	translate: (key: string, params?: Record<string, unknown>) => string,
): string {
	return proposals
		.map((p) => {
			const title = p.titleKey ? translate(p.titleKey) : p.title;
			const what = p.subject ? `${title}: ${p.subject}` : title;
			return translate(p.automatic ? 'assistant:proposed_automatic' : 'assistant:proposed', {
				what,
			});
		})
		.join('\n');
}

const MAX_STEPS = 8;
const CHAT_TIMEOUT_MS = 120_000;

/**
 * One answer of the assistant. The message was stored by `assistant.sendMessage`; this
 * job builds the tools the asking member may use, runs the model's tool loop, streams the text to
 * that member only, and stores the result. Idempotent: a finished message is left alone, and a
 * restarted turn starts the answer again.
 */
export const turnJob = defineJob({
	name: TURN_JOB,
	payload: z.object({ threadId: z.string(), messageId: z.string() }),
	timeoutMs: 150_000,
	maxAttempts: 2,
	lane: 'long',
	backoff: () => 5_000,
	async handle(ctx, { threadId, messageId }, run) {
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
			errorCode?: string | null;
			calls?: RecordedCall[];
		}) => {
			await persistHandles();
			await db
				.updateTable('assistant_messages')
				.set({
					status: fields.status,
					content: fields.content ?? '',
					error_code: fields.errorCode ?? null,
					tool_calls: fields.calls?.length ? JSON.stringify(fields.calls) : null,
				})
				.where('id', '=', messageId)
				.execute();
			await ctx.events.emitTo(memberId, assistantDone, {
				threadId,
				messageId,
				status: fields.status,
			});
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
			source: 'assistant',
			onBehalfOf: member.id as MemberId,
			roleId: member.roleId,
			// Results of local-only areas may reach the model only if it runs on the family's network.
			local: policy.local,
		};
		const history = await db
			.selectFrom('assistant_messages')
			.select(['role', 'content', 'created_at'])
			.where('thread_id', '=', threadId)
			.where('status', '=', 'done')
			.where('created_at', '<', reply.created_at)
			.orderBy('created_at', 'desc')
			.orderBy('id', 'desc')
			.limit(KEEP_VERBATIM)
			.execute();
		const kept = history.filter((m) => m.content !== '').reverse();
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
		const tools = offered;

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
		const calls: RecordedCall[] = [];
		const proposals: Proposal[] = [];
		const inject = {
			'core.addMemory': { source: 'assistant' },
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
					now: zoned(now, settings.timeZone).toPlainTime().toString({ smallestUnit: 'minute' }),
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
				}),
				maxSteps: MAX_STEPS,
				toolsClosed: () => toolsClosed(calls),
				timeoutMs: CHAT_TIMEOUT_MS,
				memberId,
				jobId: run.id,
				onText: (text) => emit(scrubber.push(text)),
			});
			emit(scrubber.flush());
			// Whatever the model wrote, the person is told what was really suggested, from the
			// suggestions themselves.
			const locale = member.locale ?? settings.locale;
			const stated = proposalLines(proposals, (key, params) => ctx.translate(locale, key, params));
			if (result.text && stated !== '') emit(`\n\n${stated}`);
			// The step limit can end the loop on a tool call: no answer text, which is a failure
			// (the drafts it made still stand and are listed).
			await finish(
				result.text
					? {
							status: 'done',
							content: `${scrubHandles(result.text, nameOf)}${stated === '' ? '' : `\n\n${stated}`}`,
							calls,
						}
					: { status: 'failed', errorCode: 'no_answer', calls },
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
