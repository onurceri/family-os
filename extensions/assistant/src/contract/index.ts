import {
	DIGEST_KINDS,
	DIGEST_STATUSES,
	DigestHrefSchema,
	idSchema,
	QUESTION_TOPIC_IDS,
} from '@famos/sdk';
import { z } from 'zod';

/**
 * Assistant contract: per-member chat threads. A message to the assistant is an
 * action that stores it and enqueues a turn (a job); the answer streams to the member over the
 * WebSocket and is stored when it is done.
 */

/** The AI feature id: its switch is in Settings → AI, and every model call records it. */
export const CHAT_FEATURE = 'assistant.chat';

/** Jobs: one answer per message, and the background summary of long threads. */
export const TURN_JOB = 'assistant.turn';
export const SUMMARIZE_JOB = 'assistant.summarize';

export const ThreadIdSchema = idSchema('asst_thread');
export const MessageIdSchema = idSchema('asst_msg');

export const MAX_TEXT = 4000;

/** Where the answer is read: in the app, or in a chat outside it (shorter words). */
export const CHANNELS = ['app', 'chat'] as const;

export const SendMessageSchema = z.object({
	threadId: ThreadIdSchema.optional().describe('Omit to start a new thread'),
	text: z.string().trim().min(1).max(MAX_TEXT),
	via: z.enum(CHANNELS).optional().describe('Where the answer is read; the app by default'),
});

export const SentMessageSchema = z.object({
	threadId: z.string(),
	messageId: z.string(),
	/** The assistant's answer, still to be written. */
	replyId: z.string(),
});

export const RenameThreadSchema = z.object({
	id: ThreadIdSchema,
	title: z.string().trim().min(1).max(80),
});

export const MESSAGE_STATUSES = ['pending', 'streaming', 'done', 'failed'] as const;

/** What the assistant did in an answer: tools used (names only) and drafts it created. */
export const ToolCallSchema = z.object({
	name: z.string(),
	ok: z.boolean(),
	draftId: z.string().optional(),
});

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One fact of an answer card, as a digest gave it, with people by name. */
export const CardItemSchema = z.object({
	kind: z.enum(DIGEST_KINDS),
	title: z.string(),
	/** The day it happens or is due; left out for what stands over days (a list, a note). */
	date: IsoDate.optional(),
	time: z.string().optional(),
	endDate: IsoDate.optional(),
	endTime: z.string().optional(),
	allDay: z.boolean().optional(),
	/** Display names of the people it is for; empty: the whole family, or anyone. */
	people: z.array(z.string()),
	notes: z.string().optional(),
	status: z.enum(DIGEST_STATUSES).optional(),
	/** Where an event is. */
	place: z.string().optional(),
	/**
	 * More of what it is: the record a duty is for, the things still on a list, the group of a
	 * suggestion.
	 */
	detail: z.string().optional(),
	/** A suggestion of the asker's own that waits for someone else to decide. */
	forOthers: z.boolean().optional(),
	/** Where the app opens it, when the extension that keeps it has a page for it. */
	href: DigestHrefSchema.optional(),
});
export type CardItem = z.infer<typeof CardItemSchema>;

export const SpanLabelSchema = z.object({
	key: z.enum([
		'today',
		'day',
		'this_week',
		'coming_days',
		'next_week',
		'weekend',
		'month',
		'until',
		'range',
	]),
	from: IsoDate,
	to: IsoDate,
});

/** Why a topic asked about has no answer here. */
export const NOT_HERE = ['not_installed', 'closed_to_ai', 'not_allowed'] as const;

/** Why the opening words were left out: the check they failed, or why there were none. */
export const LEAD_CHECKS = [
	'iso_date',
	'handle',
	'unknown_date',
	'wrong_weekday',
	'unknown_title',
	'nothing_over_items',
	'too_long',
	'empty',
	'failed',
] as const;
export type LeadCheck = (typeof LEAD_CHECKS)[number];

/**
 * The answer to a question, made by code from what the areas hold: what was understood, the facts
 * of each topic in the days asked about (or that there are none, and what comes next), and the
 * topics that cannot be answered here. The model's words, when they passed the checks, are the
 * message's `content`.
 */
export const AnswerCardSchema = z.object({
	understood: z.object({
		topics: z.array(z.enum(QUESTION_TOPIC_IDS)),
		/** Display names of the people asked about. */
		people: z.array(z.string()),
		/** A word for the whole family was said. */
		everyone: z.boolean(),
		/** Names that matched nobody in the family. */
		unmatched: z.array(z.string()),
		span: SpanLabelSchema,
		/** The question named no topic, so the days' events and tasks stand in. */
		fallback: z.boolean(),
		/** A weekday the person wrote next to a date of another weekday ("Wednesday 20 October"). */
		mismatches: z
			.array(z.object({ date: IsoDate, said: z.number().int().min(1).max(7) }))
			.optional(),
	}),
	sections: z.array(
		z.object({
			topic: z.enum(QUESTION_TOPIC_IDS),
			items: z.array(CardItemSchema),
			truncated: z.boolean(),
			/** Items the assistant may not read. */
			hidden: z.number().int().optional(),
			/**
			 * When the question was about some people: how many items the same days hold for others
			 * (`more` when that read was cut, so only "more" is known).
			 */
			others: z.object({ count: z.number().int().min(0), more: z.boolean() }).optional(),
			/** When the days hold nothing: the first item after them. */
			next: CardItemSchema.optional(),
		}),
	),
	notHere: z.array(z.object({ topic: z.enum(QUESTION_TOPIC_IDS), why: z.enum(NOT_HERE) })),
	/** Whether the opening words were kept, and if not, why. */
	lead: z.object({ kept: z.boolean(), check: z.enum(LEAD_CHECKS).nullable() }),
	/** The card as plain lines in the asker's language, for chats outside the app. */
	text: z.array(z.string()),
});
export type AnswerCard = z.infer<typeof AnswerCardSchema>;

export const MessageSchema = z.object({
	id: z.string(),
	role: z.enum(['user', 'assistant']),
	content: z.string(),
	toolCalls: z.array(ToolCallSchema),
	/**
	 * The app's own line for each suggestion the answer made, from the suggestions themselves
	 * ("Suggested, not added yet: Add a task: Pack the swim bag"). Not part of `content`: a page
	 * that shows the suggestions as cards needs no line; one that cannot shows these.
	 */
	suggested: z.array(z.string()),
	/** The answer card of a question, made by code; null for other answers. */
	card: AnswerCardSchema.nullable(),
	status: z.enum(MESSAGE_STATUSES),
	/** Why an answer failed: an `LlmErrorCode` or one of this extension's. */
	errorCode: z.string().nullable(),
	createdAt: z.number(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ThreadSchema = z.object({
	id: z.string(),
	title: z.string(),
	updatedAt: z.number(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const ThreadDetailSchema = z.object({
	thread: ThreadSchema,
	messages: z.array(MessageSchema),
});
export type ThreadDetail = z.infer<typeof ThreadDetailSchema>;

/** Events go to the asking member only (`emitTo`); they are never broadcast or stored. */
export const deltaPayload = z.object({
	threadId: z.string(),
	messageId: z.string(),
	text: z.string(),
	/** The turn starts over (a retry): forget the text received so far. */
	reset: z.boolean().optional(),
});
export const donePayload = z.object({
	threadId: z.string(),
	messageId: z.string(),
	status: z.enum(['done', 'failed']),
});
