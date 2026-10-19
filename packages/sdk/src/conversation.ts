import { z } from 'zod';
import type { Actor } from './actor.ts';
import type { ExtensionContext } from './context.ts';
import { ANY_MEMBER, defineEvent } from './events.ts';

/** A question a member asked, and where its answer will be. */
export interface ConversationAsked {
	/** The conversation the question went into; pass it with the next question to continue it. */
	threadId: string;
	/** The answer to wait for: `conversationAnswered` names it when it is written. */
	replyId: string;
}

/**
 * A finished answer. `done`: `text` is the answer; `failed`: it could not be written; `ai_off`:
 * no model may answer (switched off, no provider). `draftIds`: the suggestions it made, for a
 * channel to offer them for a decision.
 */
export interface ConversationAnswer {
	status: 'done' | 'failed' | 'ai_off';
	text: string;
	draftIds: string[];
}

/**
 * A conversation with the family's AI that channels outside the app (Telegram) can use: a member
 * asks, the answer is written later by a job, and the provider says so with
 * `conversationAnswered`. At most one extension of an installation provides it.
 */
export interface ConversationProvider {
	/** The capability a member needs to ask; checked by the host before `ask`. */
	readonly requires: string;
	/**
	 * Takes a question from the member. A `threadId` that no longer exists starts a new
	 * conversation. Throw a `FamosError` to refuse: `conflict` while the last answer is still being
	 * written.
	 */
	ask(
		ctx: ExtensionContext,
		actor: Actor,
		question: { text: string; threadId: string | null },
	): Promise<ConversationAsked>;
	/** The finished answer `replyId`, if it is this member's and written; null otherwise. */
	answer(
		ctx: ExtensionContext,
		memberId: string,
		replyId: string,
	): Promise<ConversationAnswer | null>;
}

/**
 * Emitted to the member (`events.emitTo`) when an answer of a `ConversationProvider` is written,
 * done or not. It carries the id only; channels read the answer with `answer`.
 */
export const conversationAnswered = defineEvent(
	'core.conversation.answered',
	z.object({ replyId: z.string() }),
	// Addressed to one member by `emitTo`; the answer itself is read with their own rights.
	{ audience: ANY_MEMBER },
);
