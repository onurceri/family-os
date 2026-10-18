import type { FakeChatTurn, FakeLlm } from '@famos/testing';

/** What the model reads from a message that is not a question: it goes to the tool loop. */
export const LOOP_READING = { intent: 'change', topics: [], people: [] };

/**
 * Queues answers of turns that run the tool loop: for each, the reading of the message (not a
 * question) and then the scripted chat.
 */
export function loopTurns(llm: FakeLlm, ...turns: FakeChatTurn[]): void {
	for (const turn of turns) {
		llm.respond(LOOP_READING);
		llm.respondChat(turn);
	}
}
