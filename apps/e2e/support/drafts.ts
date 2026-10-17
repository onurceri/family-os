import type { ModelAnswer } from './fake-model.ts';

type Mention = ModelAnswer['mentions'][number];

/** One thing the fake model read from a shared item: a kind and its slots. */
export function mention(kind: string, slots: Omit<Mention, 'kind'> = {}): Mention {
	return { kind, ...slots };
}

/** A day as the model quotes it: an ISO date written in the message, read as written. */
export function on(date: string): { text: string; numeric: string } {
	return { text: date, numeric: date };
}

/** What `model.answer(...)` expects: a label and the mentions read from the shared item. */
export function answer(label: string, ...mentions: Mention[]): ModelAnswer {
	return { label, intent: mentions.length > 0 ? 'actionable' : 'nothing', mentions };
}

/** The model found a question for the assistant: a label and no mentions. */
export function questionAnswer(label: string): ModelAnswer {
	return { label, intent: 'question', mentions: [] };
}
