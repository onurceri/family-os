import { idSchema } from '@famos/sdk';
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

export const SendMessageSchema = z.object({
	threadId: ThreadIdSchema.optional().describe('Omit to start a new thread'),
	text: z.string().trim().min(1).max(MAX_TEXT),
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
