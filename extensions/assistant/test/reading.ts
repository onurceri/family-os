import type { FakeChatTurn, FakeLlm } from '@famos/testing';

/**
 * What the model reads from a message that is neither a question nor a change: it goes to the
 * tool loop with every tool.
 */
export const LOOP_READING = { intent: 'other', topics: [], people: [] };

/**
 * Queues answers of turns that run the tool loop: for each, the reading of the message (not a
 * question) and then the scripted chat.
 */
export function loopTurns(llm: FakeLlm, ...turns: FakeChatTurn[]): void {
	scopedTurns(llm, LOOP_READING, ...turns);
}

/** The same for a message read as `reading` (a change, a thing to remember). */
export function scopedTurns(
	llm: FakeLlm,
	reading: Record<string, unknown>,
	...turns: FakeChatTurn[]
): void {
	for (const turn of turns) {
		llm.respond(reading);
		llm.respondChat(turn);
	}
}
